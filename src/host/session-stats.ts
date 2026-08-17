/**
 * Billing session fold: derive per-session cost and token stats from the
 * durable log, pricing each provider request at the model's effective
 * price for that request's own `time` (peak/off-peak aware).
 *
 * Pure functions only — no ctx, no clock. Safe for replay, resumable, and
 * unit-testable in isolation.
 */
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
import { effectivePrice, priceTokens, type PriceTable } from './price.ts'
import { EMPTY_STATS, RECENT_TURNS_CAP, type SessionBillingStats, type TurnCost } from '../shared.ts'

export type { SessionBillingStats } from '../shared.ts'
export { EMPTY_STATS } from '../shared.ts'

/** The fold's full mutable state: latest request header + accumulated stats. */
export interface BillingFoldState {
  header: EpochHeader | undefined
  stats: SessionBillingStats
}

/** Clone a stats value so each request gets a fresh object (immutable fold). */
function cloneStats(stats: SessionBillingStats): SessionBillingStats {
  return {
    ...stats,
    peakModels: [...stats.peakModels],
    cost: { ...stats.cost },
    byPeriod: Object.fromEntries(
      Object.entries(stats.byPeriod).map(([c, v]) => [c, { ...v }]),
    ),
    turns: [...stats.turns],
  }
}

/** Whether a price row with peak periods exists for the model. */
function modelHasPeriods(table: PriceTable, provider: string, model: string, effort: string | undefined): boolean {
  const row = table.models.find(
    m => m.provider === provider
      && m.model === model
      && (effort === undefined || m.reasoningEffort === undefined || m.reasoningEffort === effort),
  )
  return row !== undefined && row.periods !== undefined && row.periods.length > 0
}

/** Fold one committed session event into billing state. Pure over the log. */
export function foldEvent(
  state: BillingFoldState,
  event: SessionEvent,
  table: PriceTable,
): BillingFoldState {
  if (event.type === 'request/context') {
    // Context-window capacity, last-wins: a present contextWindow sets it, an
    // absent one clears it (model switched to an unknown-capacity route). A
    // value that did not change keeps the same state object (no no-op frame).
    const next = event.data.contextWindow
    if (next === state.stats.contextWindow) return state
    const stats = cloneStats(state.stats)
    if (next === undefined) delete stats.contextWindow
    else stats.contextWindow = next
    return { header: state.header, stats }
  }
  if (event.type === 'request/header') {
    const { config } = event.data.header
    const prev = state.header?.config
    // An unchanged config carries no billing information; keep the previous
    // state object so the projection does not push a no-op frame. The output
    // cap (config.maxTokens) participates: a header that only changed its
    // maxTokens still updates maxOutputTokens.
    if (
      prev !== undefined
      && prev.provider === config.provider
      && prev.model === config.model
      && prev.reasoningEffort === config.reasoningEffort
      && prev.maxTokens === config.maxTokens
    ) {
      return state
    }
    const stats = cloneStats(state.stats)
    stats.currentModel = {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
    }
    if (config.maxTokens === undefined) delete stats.maxOutputTokens
    else stats.maxOutputTokens = config.maxTokens
    return { header: event.data.header, stats }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    const header = state.header
    if (header === undefined) return state
    const { config } = header
    const usage = event.data.usage
    const uncachedInputTokens = usage.inputTokens
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    const outputTokens = usage.outputTokens
    const totalInputLength = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
    const eff = effectivePrice(
      table,
      config.provider,
      config.model,
      config.reasoningEffort,
      event.time,
      totalInputLength,
      outputTokens,
    )
    const cost = priceTokens(uncachedInputTokens, eff.input)
      + priceTokens(cacheReadTokens, eff.cacheInput)
      + priceTokens(cacheWriteTokens, eff.cacheWrite)
      + priceTokens(outputTokens, eff.output)

    const stats = cloneStats(state.stats)
    stats.uncachedInputTokens += uncachedInputTokens
    stats.cacheReadTokens += cacheReadTokens
    stats.cacheWriteTokens += cacheWriteTokens
    stats.outputTokens += outputTokens
    stats.lastRequestInputTokens = totalInputLength

    let currency: string | undefined
    if (eff.found) {
      currency = table.providers[config.provider]?.currency ?? 'CNY'
      stats.requestCount += 1
      stats.cost[currency] = (stats.cost[currency] ?? 0) + cost
      const period = stats.byPeriod[currency] ?? { offPeak: 0, peak: 0 }
      if (eff.period === 'peak') period.peak += cost
      else period.offPeak += cost
      stats.byPeriod[currency] = period
      if (modelHasPeriods(table, config.provider, config.model, config.reasoningEffort)) {
        stats.hasPeakConfig = true
        const key = `${config.provider}/${config.model}`
        if (!stats.peakModels.includes(key)) stats.peakModels.push(key)
      }
    } else {
      stats.unpricedRequestCount += 1
    }

    // One row per request, priced the same way the totals are. Unpriced
    // requests still record their real tokens (priced: false, cost 0) so the
    // detail matches the totals. Truncation to RECENT_TURNS_CAP happens in
    // the projection apply wrapper — the fold keeps full history for the
    // turns route.
    stats.turns.push({
      turn: event.data.turn,
      step: event.data.step,
      time: event.time,
      inputTokens: totalInputLength,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      cacheHitRate: uncachedInputTokens + cacheReadTokens > 0
        ? cacheReadTokens / (uncachedInputTokens + cacheReadTokens)
        : 0,
      cost: eff.found ? cost : 0,
      currency: currency ?? 'CNY',
      period: eff.period,
      priced: eff.found,
    })

    const totalInput = stats.uncachedInputTokens + stats.cacheReadTokens
    stats.cacheHitRate = totalInput > 0 ? stats.cacheReadTokens / totalInput : 0
    return { header, stats }
  }
  return state
}

/** Fold an entire event log from the empty state. */
export function foldBilling(
  events: readonly SessionEvent[],
  table: PriceTable,
): SessionBillingStats {
  let state: BillingFoldState = { header: undefined, stats: EMPTY_STATS }
  for (const event of events) state = foldEvent(state, event, table)
  return state.stats
}

/** Bound a `turns` array to the most recent RECENT_TURNS_CAP conversation
 *  TURNS, keeping every request of the kept turns (a turn with many
 *  tool-calling steps keeps all its requests). Truncation is per-turn so the
 *  turn-aggregated views see the same recent turns as the request view. */
export function boundTurns(turns: readonly TurnCost[]): TurnCost[] {
  if (turns.length <= RECENT_TURNS_CAP) return [...turns]
  const kept: TurnCost[] = []
  const seenTurns = new Set<string>()
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!
    const key = `${t.turn}:${t.currency}`
    if (!seenTurns.has(key)) {
      if (seenTurns.size >= RECENT_TURNS_CAP) break
      seenTurns.add(key)
    }
    kept.push(t)
  }
  return kept.reverse()
}

/** Fold the log and bound `turns` to the most recent RECENT_TURNS_CAP
 *  conversation TURNS (not requests) for the projection frame. The raw fold
 *  keeps full history (the turns route needs it); only the projection path
 *  truncates so every pushed frame stays bounded. */
export function foldBillingBounded(
  events: readonly SessionEvent[],
  table: PriceTable,
): SessionBillingStats {
  const stats = foldBilling(events, table)
  if (stats.turns.length <= RECENT_TURNS_CAP) return stats
  return {
    ...stats,
    turns: boundTurns(stats.turns),
  }
}
