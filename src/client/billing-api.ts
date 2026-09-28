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
  constructor(readonly code: string, message: string) {
    super(message)
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

/** Read the live provider catalog (registered providers + their models), plus
 *  the price file's and the holiday calendars' state (both undefined on an
 *  older host). */
export async function getProviderCatalog(): Promise<{
  providers: ProviderCatalogRow[]
  priceFile?: PriceFileStatus
  calendar?: CalendarStatus
}> {
  return call<{ providers: ProviderCatalogRow[]; priceFile?: PriceFileStatus; calendar?: CalendarStatus }>('catalog', {})
}

/** Fetch a session's FULL per-request consumption history for the detail panel. */
export async function getTurns(sessionId: string): Promise<TurnCost[]> {
  const value = await call<{ turns: TurnCost[] }>('turns', { sessionId })
  return value.turns
}

/**
 * Recompute one session with the latest price table and return its fresh
 * stats (the host folds the live log on demand).
 */
export async function refreshSessionStats(sessionId: string): Promise<SessionBillingStats> {
  const value = await call<{ stats: SessionBillingStats }>('refresh', { sessionId })
  return value.stats
}

/**
 * Fold one session's whole subagent tree (each child's own log, current
 * price table) into family totals + per-child rows. Stateless: every call
 * re-folds fresh, so pollers simply call again.
 */
export async function getSubagentsStats(sessionId: string): Promise<SubagentsBillingStats> {
  return call<SubagentsBillingStats>('subagents', { sessionId })
}
