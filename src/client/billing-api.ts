/**
 * Client-side fetch wrapper over the /billing/api JSON routes (mirrors the
 * reference third-party plugin's own route client). The host fences these
 * to loopback; the client is served from that same host.
 *
 * The price table itself does NOT transit here: reads/writes ride the
 * harness's native settings transport via the `configForms` binding (see
 * `pricing-scope.ts`). These routes remain for what the settings transport
 * not cover: the live LLM catalog and on-demand session folds.
 */
import type { ModelPrice, PeakPeriod, PriceTable, PriceFileStatus, CalendarStatus, PriceTier, SessionBillingStats, ModelCapability, TurnCost, SubagentsBillingStats } from '../shared.ts'

export type { ModelPrice, PeakPeriod, PriceTable, PriceFileStatus, CalendarStatus, PriceTier, SessionBillingStats, ModelCapability, TurnCost, SubagentsBillingStats } from '../shared.ts'

/** One provider group in the editor catalog. */
export interface ProviderCatalogRow {
  id: string
  name: string
  models: { id: string; name: string; capability?: ModelCapability }[]
}

/** A route failure with the wire code. */
export class BillingApiError extends Error {
  /** Wire/transport code: `network`, `http`, `invalid`, or a host-supplied one. */
  readonly code: string

  // A plain field, NOT a constructor parameter property: the repo's tests run
  // through node's strip-only TypeScript loader, which rejects parameter
  // properties outright (this file is imported by tests/client-regression-check.ts).
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** POST one /billing/api method. */
async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/billing/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new BillingApiError('network', error instanceof Error ? error.message : String(error))
  }
  const parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null
    = await response.json().catch(() => null)
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new BillingApiError(
      parsed?.error?.code ?? 'http',
      parsed?.error?.message ?? `HTTP ${response.status}`,
    )
  }
  return parsed.value as T
}

/**
 * Whether a JSON value is a non-null, non-array object. Route payloads are
 * cast by `call`, so every consumer below checks the shapes it dereferences.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reject a payload missing a field the UI dereferences. Minimal ON PURPOSE:
 * only shapes that crash a render (or feed `undefined` into the fold) are
 * checked, never the whole schema — the host owns validating what it sends.
 * Thrown as `BillingApiError`, so every existing load/fail state handles it
 * exactly like an HTTP failure.
 */
function badPayload(method: string, detail: string): never {
  throw new BillingApiError('invalid', `${method}: unexpected payload (${detail})`)
}

/** One /turns row: the numeric token/cost fields the fold and chart read. */
function isTurnCost(value: unknown): boolean {
  return isRecord(value)
    && typeof value.turn === 'number'
    && typeof value.step === 'number'
    && typeof value.time === 'number'
    && typeof value.inputTokens === 'number'
    && typeof value.cacheReadTokens === 'number'
    && typeof value.cacheWriteTokens === 'number'
    && typeof value.outputTokens === 'number'
    && typeof value.cost === 'number'
    && typeof value.currency === 'string'
    && typeof value.priced === 'boolean'
}

/** One /subagents child row: the fields its row view reads unguarded. */
function isSubagentRow(value: unknown): boolean {
  return isRecord(value) && typeof value.sessionId === 'string' && isRecord(value.cost)
}

/** One /catalog provider row: `buildEditor` maps over `models` directly. */
function isCatalogProvider(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && Array.isArray(value.models)
    && value.models.every(model => isRecord(model) && typeof model.id === 'string')
}

/** Read the live provider catalog (registered providers + their models), plus
 *  the price file's and the holiday calendars' state (both undefined on an
 *  older host). */
export async function getProviderCatalog(): Promise<{
  providers: ProviderCatalogRow[]
  priceFile?: PriceFileStatus
  calendar?: CalendarStatus
}> {
  const value = await call<{ providers?: unknown; priceFile?: unknown; calendar?: unknown }>('catalog', {})
  if (!Array.isArray(value.providers) || !value.providers.every(isCatalogProvider)) {
    badPayload('catalog', 'providers')
  }
  const priceFile = value.priceFile
  // Only the fields the card reads once it decides to show the notice: a host
  // that omits `present` simply has no notice, which is not a failure.
  if (priceFile !== undefined && !(isRecord(priceFile)
    && (!priceFile.present
      || (typeof priceFile.path === 'string' && typeof priceFile.rows === 'number' && Array.isArray(priceFile.errors))))) {
    badPayload('catalog', 'priceFile')
  }
  const calendar = value.calendar
  if (calendar !== undefined && !(isRecord(calendar) && Array.isArray(calendar.names)
    && Array.isArray(calendar.years) && Array.isArray(calendar.missing) && Array.isArray(calendar.invalid))) {
    badPayload('catalog', 'calendar')
  }
  return value as { providers: ProviderCatalogRow[]; priceFile?: PriceFileStatus; calendar?: CalendarStatus }
}

/** Fetch a session's FULL per-request consumption history for the detail panel. */
export async function getTurns(sessionId: string): Promise<TurnCost[]> {
  const value = await call<{ turns?: unknown }>('turns', { sessionId })
  // `setTurns(value.turns)` feeds `aggregateTurns` and `turns.length` during
  // render, so a renamed/dropped `turns` field must fail here, not there.
  if (!Array.isArray(value.turns) || !value.turns.every(isTurnCost)) badPayload('turns', 'turns')
  return value.turns as TurnCost[]
}

/**
 * Recompute one session with the latest price table and return its fresh
 * stats (the host folds the live log on demand).
 */
export async function refreshSessionStats(sessionId: string): Promise<SessionBillingStats> {
  const value = await call<{ stats?: unknown }>('refresh', { sessionId })
  const stats = value.stats
  // These four are dereferenced unconditionally by the card's title figure,
  // period split and context bar; anything else degrades to a blank/NaN cell.
  if (!(isRecord(stats) && isRecord(stats.cost) && isRecord(stats.byPeriod) && Array.isArray(stats.turns))) {
    badPayload('refresh', 'stats')
  }
  return stats as unknown as SessionBillingStats
}

/**
 * Fold one session's whole subagent tree (each child's own log, current
 * price table) into family totals + per-child rows. Stateless: every call
 * re-folds fresh, so pollers simply call again.
 */
export async function getSubagentsStats(sessionId: string): Promise<SubagentsBillingStats> {
  const value = await call<unknown>('subagents', { sessionId })
  // `totalCount` drives the section's visibility, `cost`/`children` are read
  // with Object.keys/.map the moment it renders.
  if (!(isRecord(value) && typeof value.totalCount === 'number' && isRecord(value.cost)
    && Array.isArray(value.children) && value.children.every(isSubagentRow))) {
    badPayload('subagents', 'stats')
  }
  return value as unknown as SubagentsBillingStats
}
