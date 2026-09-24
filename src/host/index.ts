/**
 * Billing host plugin: per-session cost + token stats with peak-aware
 * pricing, computed from the durable session log and a user-editable price
 * table (per-provider currency, per-model peak windows). Registers:
 *  - the entry's volatile `Config` (the whole price table — defaults +
 *    user overrides) through the settings describe mirror,
 *  - a `billing` session-projection unit (the fold the UI reads),
 *  - fenced `/billing/api` HTTP routes for the provider catalog, per-turn
 *    detail, and refresh.
 *
 * Price-table reads/writes ride the harness's native settings transport
 * (dsh ≥ 0.1.7-rc.1: per-entry volatile Config; the client binds the entry's
 * form through `configForms`). A volatile-only edit commits in place — the
 * fiber keeps running and `settings/document-updated` re-mounts the
 * projection with the new table. The remaining fenced JSON routes cover what
 * the settings transport does not: the live LLM catalog and on-demand
 * session folds.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { HostContext } from './context-types.ts'
import type { SessionBillingStats, PriceTable, ModelPrice, ModelCapability, TurnCost } from '../shared.ts'
import { BILLING_ENTRY_ID, RECENT_TURNS_CAP } from '../shared.ts'
import { foldBilling, foldEvent, foldBillingBounded, boundTurns, EMPTY_STATS } from './session-stats.ts'
import type { BillingFoldState } from './session-stats.ts'
import { subagentsForSession, setSubagentTableSource } from './subagent-stats.ts'
import { DEFAULT_TABLE } from './default-prices.ts'
import { BillingRouteError, readJsonBody, writeError, writeOk } from './wire.ts'
import { billingFence } from './fence.ts'
// Host-side `billing` key merge into SessionProjectionStateMap (type-only).
import type {} from './projection-types.ts'

/** The plugin's Host entry id (also the settings entry the client binds). */
export const BILLING_ID = BILLING_ENTRY_ID

/** Schemastery schema for the price table (per-provider currency + model rows). */
const tierSchema = z.object({
  inputMin: z.number().min(0),
  inputMax: z.number().min(0),
  outputMin: z.number().min(0),
  outputMax: z.number().min(0),
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
})

const periodSchema = z.object({
  startHour: z.number().min(0).max(23).required(),
  endHour: z.number().min(1).max(24).required(),
  days: z.array(z.number().min(0).max(6)),
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
  tiers: z.array(tierSchema).default([]),
})

const modelPriceSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
  periods: z.array(periodSchema).default([]),
  tiers: z.array(tierSchema).default([]),
})

const providerCurrencySchema = z.object({
  currency: z.union([z.const('CNY'), z.const('USD')]).default('CNY'),
  currencySymbol: z.string().default('¥'),
  // IANA timezone for judging this provider's peak windows; absent → the
  // settings page seeds Asia/Shanghai and the fold falls back to it anyway.
  timezone: z.string().max(64),
})

const priceTableSchema = z.object({
  providers: z.dict(providerCurrencySchema).default(DEFAULT_TABLE.providers),
  models: z.array(modelPriceSchema).default(DEFAULT_TABLE.models),
})

/** The billing entry's Config: the whole price table as ONE volatile ref
 *  (dsh ≥ 0.1.7-rc.1 settings model). The default IS the built-in table, so
 *  an entry without user overrides resolves to DEFAULT_TABLE; the settings
 *  UI edits it live (volatile) and the host reads `config.get()`. */
export const Config = priceTableSchema.volatile() as unknown as z<PriceTable, PriceTable, 'volatile'>

/** The resolved price-table ref handed to apply (whole-object volatile). */
export type PriceTableConfig = { get(): PriceTable }

/** The fold state the projection unit drives (header + stats). */
export interface BillingProjectionState extends BillingFoldState {}

/** Immutable resolved price table handed to the fold. */
function freezeTable(value: PriceTable): PriceTable {
  return {
    providers: { ...value.providers },
    models: value.models.map(m => ({
      ...m,
      periods: m.periods?.map(p => ({ ...p, tiers: p.tiers?.map(t => ({ ...t })) })),
      tiers: m.tiers?.map(t => ({ ...t })),
    })),
  }
}

/**
 * A content revision of the price table (FNV-1a over its canonical JSON).
 * Mixed into the projection's `stateVersion`: a price edit bumps the version,
 * so persisted projection checkpoints seeded with OLD prices go stale and
 * cold reads re-fold the whole log with the current table — otherwise a
 * checkpoint could silently resurrect pre-edit costs. Same table → same
 * revision → checkpoints stay valid across restarts.
 */
function tableRevision(table: PriceTable): number {
  const text = JSON.stringify(table)
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Base projection schema version, bumped on fold-state/view shape changes.
 *  8: fold state keeps only header.config; compactions gains tokens/cost. */
const STATE_VERSION_BASE = 8

/**
 * The billing host plugin.
 * @param ctx - host plugin context.
 */
export function apply(ctx: HostContext, config: PriceTableConfig): void {
  // Resolved price table in a mutable holder; the projection unit's closures
  // always read the CURRENT table (settings-change aware).
  const holder: { table: PriceTable } = { table: freezeTable(config.get()) }

  // Keep the native settings UI off the auto-generated generic form: the
  // client contributes its own billing settings tab.
  ctx.settings.configure({ auto: false }, ctx.fiber)

  // Projection unit: folds the log to billing stats. Recompute = dispose +
  // re-register, which drops every session's cached cell so the next read
  // re-folds the whole log with the current table. The change feed pushes
  // fresh `billing` frames to every connected client.
  let registry: HostContext['sessionProjections'] | undefined
  let disposeProjection: (() => void) | undefined
  const mountProjection = (): void => {
    disposeProjection?.()
    disposeProjection = undefined
    holder.table = freezeTable(config.get())
    // The wire view a client consumes is the fold's `stats` half; the fold's
    // persisted state carries `{config, stats}`. dsh ≤ 0.1.0-rc.7 validated
    // the VIEW with a top-level `schema`; dsh ≥ 0.1.1-rc.1 validates the
    // persisted STATE with `stateSchema` and the view with `wire.viewSchema`
    // (and only a `wire`-carrying unit is snapshotted + pushed to clients).
    // Both shapes are emitted so one registration works across the harness
    // versions dsh-meter supports (extra keys are ignored by each reader).
    const statsSchema = zod.object({
      uncachedInputTokens: zod.number().int().nonnegative(),
      cacheReadTokens: zod.number().int().nonnegative(),
      cacheWriteTokens: zod.number().int().nonnegative(),
      outputTokens: zod.number().int().nonnegative(),
      // Price units are integers by construction (priceTokens floors); a
      // float here would mean the settings schema let a fractional price
      // through, so fail the frame loud instead of rendering a bogus cost.
      cacheHitRate: zod.number().min(0).max(1),
      requestCount: zod.number().int().nonnegative(),
      unpricedRequestCount: zod.number().int().nonnegative(),
      hasPeakConfig: zod.boolean(),
      peakModels: zod.array(zod.string()),
      currentModel: zod.object({
        provider: zod.string(),
        model: zod.string(),
        reasoningEffort: zod.string().optional(),
      }).optional(),
      cost: zod.record(zod.string(), zod.number().int().nonnegative()),
      byPeriod: zod.record(zod.string(), zod.object({
        offPeak: zod.number().int().nonnegative(),
        peak: zod.number().int().nonnegative(),
      })),
      turns: zod.array(zod.object({
        turn: zod.number().int().nonnegative(),
        step: zod.number().int().nonnegative(),
        time: zod.number().int().nonnegative(),
        inputTokens: zod.number().int().nonnegative(),
        cacheReadTokens: zod.number().int().nonnegative(),
        cacheWriteTokens: zod.number().int().nonnegative(),
        outputTokens: zod.number().int().nonnegative(),
        cacheHitRate: zod.number(),
        cost: zod.number().int().nonnegative(),
        currency: zod.string(),
        period: zod.union([zod.literal('peak'), zod.literal('off-peak')]),
        priced: zod.boolean(),
      })),
      lastRequestInputTokens: zod.number().int().nonnegative().optional(),
      contextWindow: zod.number().int().positive().optional(),
      maxOutputTokens: zod.number().int().positive().optional(),
      compactions: zod.object({
        count: zod.number().int().nonnegative(),
        lastTime: zod.number().int().nonnegative().optional(),
        lastShadowedTokens: zod.number().int().nonnegative().optional(),
        tokens: zod.number().int().nonnegative(),
        cost: zod.record(zod.string(), zod.number().int().nonnegative()),
      }),
    })
    const stateSchema = zod.object({
      config: zod.object({
        provider: zod.string(),
        model: zod.string(),
        reasoningEffort: zod.string().optional(),
        temperature: zod.number().optional(),
        maxTokens: zod.number().int().positive().optional(),
        stop: zod.array(zod.string()).optional(),
      }).optional(),
      stats: statsSchema,
    })
    // Legacy rc.7 fields (dsh ≤ 0.1.0-rc.7 reads a top-level `schema` + `view`
    // as the wire-view pair). Spread separately so the 0.1.1-rc.1 literal stays
    // excess-property-clean while the emitted object still carries them — each
    // registry version reads only the keys it knows.
    const legacyWire = {
      schema: statsSchema as unknown as zod.ZodType<SessionBillingStats>,
      view: (state: BillingProjectionState) => state.stats,
    }
    disposeProjection = registry?.register<'billing', BillingProjectionState>({
      key: 'billing',
      // dsh ≥ 0.1.1-rc.1: persisted-state validation (state) + wire view (stats).
      stateSchema: stateSchema as unknown as zod.ZodType<BillingProjectionState>,
      wire: {
        viewSchema: statsSchema as unknown as zod.ZodType<SessionBillingStats>,
        view: state => state.stats,
      },
      init: () => ({ stats: EMPTY_STATS }),
      // The fold keeps full history; bound turns by TURN here so every pushed
      // frame stays at RECENT_TURNS_CAP turns (bounded projection size) while
      // keeping a turn's tool-calling steps together.
      apply: (state, event) => {
        const next = foldEvent(state, event, holder.table)
        if (next.stats.turns.length > RECENT_TURNS_CAP) {
          // Same lossless-JSON rule as the fold: no explicit undefined key.
          return { ...(next.config === undefined ? {} : { config: next.config }), stats: { ...next.stats, turns: boundTurns(next.stats.turns) } }
        }
        return next
      },
      // The table revision participates so a price edit invalidates every
      // checkpoint folded with old prices (see tableRevision).
      stateVersion: STATE_VERSION_BASE * 2 ** 20 + (tableRevision(holder.table) % 2 ** 20),
      ...legacyWire,
    })
  }

  // One inject fiber for the plugin's lifetime: capture the registry once the
  // optional session-projection seam is composed, mount, and re-mount only by
  // re-registering on it (never by re-injecting, which would leak fibers).
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    registry = projectionCtx.sessionProjections
    mountProjection()
    return () => {
      disposeProjection?.()
      disposeProjection = undefined
      registry = undefined
    }
  })

  // A volatile price-table edit commits in place without restarting this
  // fiber; the settings document change is the re-mount signal.
  ctx.effect(() => ctx.on('settings/document-updated', (ns: string) => {
    if (ns === BILLING_ENTRY_ID) mountProjection()
  }), 'billing: price-table watcher')

  // Background subagent warming prices with the SAME table the route serves
  // (the holder updates on settings changes and refresh).
  setSubagentTableSource(() => holder.table)

  // /billing/api routes: catalog, turns, refresh. Fenced to loopback
  // (DNS-rebinding defense); the client fetches these. The price table itself
  // no longer transits here — it rides the native settings RPC.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/billing/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!billingFence(req)) {
        writeError(res, new BillingRouteError('forbidden', 'forbidden', 403))
        return
      }
      if (req.method !== 'POST') {
        writeError(res, new BillingRouteError('method-error', 'method not allowed', 405))
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/billing/api/') ? pathname.slice('/billing/api/'.length) : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res, new BillingRouteError('not-found', 'unknown billing API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req)
        switch (method) {
          case 'catalog':
            writeOk(res, await catalog(ctx))
            break
          case 'turns':
            writeOk(res, turnsForSession(ctx, payload, holder.table))
            break
          case 'subagents':
            writeOk(res, await subagentsForSession(
              requireSessionId(payload),
              { sessions: ctx.sessions, persistence: ctx.get('sessionPersistence') },
              holder.table,
            ))
            break
          case 'refresh': {
            // Sync the table and fold only the requested session. The
            // settings watcher already re-mounts the projection on price
            // changes; a card refresh must not drop every session's cell.
            holder.table = freezeTable(config.get())
            writeOk(res, refreshSession(ctx, payload, holder.table))
            break
          }
          default:
            writeError(res, new BillingRouteError('not-found', `unknown billing API method "${method}"`, 404))
        }
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'billing: /billing/api routes')

  ctx.effect(() => () => { disposeProjection?.() }, 'billing: projection teardown')
}

/** Group the live registered providers and their model catalogs for the
 *  editor, each model carrying its best-effort capability (context window /
 *  output cap) resolved from the adapter. A model whose resolution fails
 *  simply has no capability — it does not fail the whole group. */
async function catalog(ctx: HostContext): Promise<{
  providers: {
    id: string
    name: string
    models: { id: string; name: string; capability?: ModelCapability }[]
  }[]
}> {
  const providers = ctx.llm.listProviders()
  // Providers resolve concurrently (each model inside a provider still
  // parallel), so a slow adapter cannot serialize the whole editor load.
  const rows = await Promise.all(providers.map(async provider => {
    let models: { id: string; name: string; capability?: ModelCapability }[] = []
    try {
      const listed = await ctx.llm.listModels(provider.id)
      models = await Promise.all(listed.map(async m => {
        let capability: ModelCapability | undefined
        try {
          const info = await ctx.llm.resolveModelInfo(provider.id, m.id)
          capability = {
            ...(info.context !== undefined ? { contextWindow: info.context.contextWindow } : {}),
            ...(info.defaultMaxTokens !== undefined ? { maxTokens: info.defaultMaxTokens } : {}),
          }
          if (capability.contextWindow === undefined && capability.maxTokens === undefined) capability = undefined
        } catch {
          // A model that cannot be resolved carries no capability.
        }
        return { id: m.id, name: m.name, ...(capability !== undefined ? { capability } : {}) }
      }))
    } catch {
      // A provider without a listable catalog contributes an empty group.
      models = []
    }
    return { id: provider.id, name: provider.name, models }
  }))
  return { providers: rows }
}

/** Validate a route body's sessionId (the wire string is an opaque branded
 *  SessionId; the store validates it on lookup, unknown ids → undefined). */
function requireSessionId(payload: unknown): string {
  const body = payload as { sessionId?: unknown }
  if (body === null || typeof body !== 'object' || typeof body.sessionId !== 'string') {
    throw new BillingRouteError('bad-payload', 'missing "sessionId"', 400)
  }
  return body.sessionId
}

/**
 * Recompute one session's billing with the current price table, folding its
 * live event log on demand. The result is returned only to the CALLING
 * client (other tabs catch up on the next projection frame); the settings
 * watcher is what re-mounts the projection after a price change. Turns are
 * bounded to RECENT_TURNS_CAP (the card only needs the recent few).
 */
function refreshSession(
  ctx: HostContext,
  payload: unknown,
  table: PriceTable,
): { ok: true; stats: SessionBillingStats } {
  const session = ctx.sessions.get(requireSessionId(payload) as never)
  if (session === undefined) {
    throw new BillingRouteError('not-found', 'unknown session', 404)
  }
  return { ok: true, stats: foldBillingBounded(session.snapshotEvents(), table) }
}

/** Return a session's FULL per-request consumption history (unbounded,
 *  ascending) for the detail panel, folding its live log on demand. */
function turnsForSession(
  ctx: HostContext,
  payload: unknown,
  table: PriceTable,
): { ok: true; turns: TurnCost[] } {
  const session = ctx.sessions.get(requireSessionId(payload) as never)
  if (session === undefined) {
    throw new BillingRouteError('not-found', 'unknown session', 404)
  }
  return { ok: true, turns: foldBilling(session.snapshotEvents(), table).turns }
}

export const name = 'billing'

/** Services the host plugin reads directly at apply time. `sessionProjections`
 *  stays a lazy `ctx.inject` (an optional seam, composed by dsh-base). */
export const inject = ['settings', 'webServer', 'sessions', 'llm']
