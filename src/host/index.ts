/**
 * Billing host plugin: per-session cost + token stats with peak-aware
 * pricing, computed from the durable session log and a user-editable price
 * table (per-provider currency, per-model peak windows). Registers:
 *  - a `billing-pricing` settings namespace (defaults + user overrides),
 *  - a `billing` session-projection unit (the fold the UI reads),
 *  - fenced `/billing/api` HTTP routes for the provider catalog, per-turn
 *    detail, and refresh.
 *
 * Price-table reads/writes ride the harness's native settings RPC (served for
 * every registered namespace since rc.7 — no exposure whitelist anymore); the
 * client binds a `settingsScope` to the namespace. The remaining fenced JSON
 * routes cover what the settings RPC does not: the live LLM catalog and
 * on-demand session folds.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { HostContext } from './context-types.ts'
import type { SessionBillingStats, PriceTable, ModelPrice, ModelCapability, TurnCost } from '../shared.ts'
import { PRICING_NAMESPACE, RECENT_TURNS_CAP } from '../shared.ts'
import { foldBilling, foldEvent, foldBillingBounded, boundTurns, EMPTY_STATS } from './session-stats.ts'
import type { BillingFoldState } from './session-stats.ts'
import { DEFAULT_TABLE } from './default-prices.ts'
import { BillingRouteError, readJsonBody, writeError, writeOk } from './wire.ts'
import { billingFence } from './fence.ts'

/** The settings namespace for this plugin. */
export const PRICING_NS = settingsNamespace(PRICING_NAMESPACE)

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
})

const priceTableSchema = z.object({
  providers: z.dict(providerCurrencySchema).default({}),
  models: z.array(modelPriceSchema).default([]),
})

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
export function apply(ctx: HostContext): void {
  // Resolved price table in a mutable holder; the projection unit's closures
  // always read the CURRENT table (settings-change aware).
  const holder: { table: PriceTable } = { table: freezeTable(DEFAULT_TABLE) }

  // Settings namespace: built-in table as the composition `base`; users
  // override via the settings page (through our own fenced routes).
  const scope = ctx.settings.register<PriceTable>(PRICING_NS, priceTableSchema, {
    base: DEFAULT_TABLE,
    applies: 'live',
  })

  // Projection unit: folds the log to billing stats. Recompute = dispose +
  // re-register, which drops every session's cached cell so the next read
  // re-folds the whole log with the current table. The change feed pushes
  // fresh `billing` frames to every connected client.
  let registry: HostContext['sessionProjections'] | undefined
  let disposeProjection: (() => void) | undefined
  const mountProjection = (): void => {
    disposeProjection?.()
    disposeProjection = undefined
    holder.table = freezeTable(scope.get())
    disposeProjection = registry?.register<'billing', BillingProjectionState>({
      key: 'billing',
      schema: zod.object({
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
      }) as unknown as zod.ZodType<SessionBillingStats>,
      init: () => ({ config: undefined, stats: EMPTY_STATS }),
      // The fold keeps full history; bound turns by TURN here so every pushed
      // frame stays at RECENT_TURNS_CAP turns (bounded projection size) while
      // keeping a turn's tool-calling steps together.
      apply: (state, event) => {
        const next = foldEvent(state, event, holder.table)
        if (next.stats.turns.length > RECENT_TURNS_CAP) {
          return { config: next.config, stats: { ...next.stats, turns: boundTurns(next.stats.turns) } }
        }
        return next
      },
      view: state => state.stats,
      // The table revision participates so a price edit invalidates every
      // checkpoint folded with old prices (see tableRevision).
      stateVersion: STATE_VERSION_BASE * 2 ** 20 + (tableRevision(holder.table) % 2 ** 20),
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

  ctx.effect(() => scope.watch(() => mountProjection()), 'billing: price-table watcher')

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
          case 'refresh': {
            // Sync the table and fold only the requested session. The
            // settings watcher already re-mounts the projection on price
            // changes; a card refresh must not drop every session's cell.
            holder.table = freezeTable(scope.get())
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
  const body = payload as { sessionId?: unknown }
  if (body === null || typeof body !== 'object' || typeof body.sessionId !== 'string') {
    throw new BillingRouteError('bad-payload', 'missing "sessionId"', 400)
  }
  // The wire string is an opaque branded SessionId; the store validates it
  // (unknown ids return undefined), so no local check is needed.
  const session = ctx.sessions.get(body.sessionId as never)
  if (session === undefined) {
    throw new BillingRouteError('not-found', 'unknown session', 404)
  }
  return { ok: true, stats: foldBillingBounded(session.events, table) }
}

/** Return a session's FULL per-request consumption history (unbounded,
 *  ascending) for the detail panel, folding its live log on demand. */
function turnsForSession(
  ctx: HostContext,
  payload: unknown,
  table: PriceTable,
): { ok: true; turns: TurnCost[] } {
  const body = payload as { sessionId?: unknown }
  if (body === null || typeof body !== 'object' || typeof body.sessionId !== 'string') {
    throw new BillingRouteError('bad-payload', 'missing "sessionId"', 400)
  }
  const session = ctx.sessions.get(body.sessionId as never)
  if (session === undefined) {
    throw new BillingRouteError('not-found', 'unknown session', 404)
  }
  return { ok: true, turns: foldBilling(session.events, table).turns }
}

export const name = 'billing'

/** Services the host plugin reads directly at apply time. `sessionProjections`
 *  stays a lazy `ctx.inject` (an optional seam, composed by dsh-base). */
export const inject = ['settings', 'webServer', 'sessions', 'llm']
