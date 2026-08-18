/**
 * Billing session fold: derive per-session cost and token stats from the
 * durable log, pricing each provider request at the model's effective
 * price for that request's own `time` (peak/off-peak aware).
 *
 * Pure functions only — no ctx, no clock. Safe for replay, resumable, and
 * unit-testable in isolation.
 */
import type { EpochHeader, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: brings the `compaction/*` SessionEventMap variants into scope.
import type {} from '@deepseek-ai/dsh-compaction'
import { priceRequest, type PriceTable } from './price.ts'
import { EMPTY_STATS, findPriceRow, RECENT_TURNS_CAP, type SessionBillingStats, type TurnCost } from '../shared.ts'

export type { SessionBillingStats } from '../shared.ts'
export { EMPTY_STATS } from '../shared.ts'

/** The request config the fold prices with (EpochHeader carries the rendered
 *  system prompt and tool schemas too — dozens of KB the fold never reads,
 *  so the state keeps only the config and the projection checkpoint stays
 *  free of that redundant, sensitive text). */
type HeaderConfig = EpochHeader['config']

/** The fold's full mutable state: latest request config + accumulated stats. */
export interface BillingFoldState {
  config: HeaderConfig | undefined
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
    compactions: { ...stats.compactions, cost: { ...stats.compactions.cost } },
  }
}

/** Whether a price row with peak periods exists for the model. */
function modelHasPeriods(table: PriceTable, provider: string, model: string, effort: string | undefined): boolean {
  const row = findPriceRow(table, provider, model, effort)
  return row !== undefined && row.periods !== undefined && row.periods.length > 0
}

/**
 * The `peakModels` key for one priced request. Provider ids contain no '/',
 * and the effort segment (when the request priced an effort-specific row)
 * carries the effort so the client can resolve the SAME row — effort rows
 * take precedence over the generic row, so a bare `provider/model` key would
 * let the client's peak tag look up the wrong (generic) row.
 */
function peakKey(provider: string, model: string, effort: string | undefined): string {
  return effort !== undefined ? `${provider}/${model}/${effort}` : `${provider}/${model}`
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
    return { config: state.config, stats }
  }
  if (event.type === 'request/header') {
    const { config } = event.data.header
    const prev = state.config
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
    return { config, stats }
  }
  if (event.type === 'assistant/message' && event.data.usage !== undefined) {
    const config = state.config
    if (config === undefined) return state
    const usage = event.data.usage
    const uncachedInputTokens = usage.inputTokens
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheWriteTokens = usage.cacheWriteTokens ?? 0
    const outputTokens = usage.outputTokens
    const totalInputLength = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
    // One pricing formula, one place: priceRequest resolves the effective
    // tier/period price AND prices the four buckets, so the fold and any
    // future caller can never drift apart.
    const { priceUnits: cost, currency, period, found } = priceRequest(
      table,
      config.provider,
      config.model,
      config.reasoningEffort,
      event.time,
      { inputTokens: uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
    )

    const stats = cloneStats(state.stats)
    stats.uncachedInputTokens += uncachedInputTokens
    stats.cacheReadTokens += cacheReadTokens
    stats.cacheWriteTokens += cacheWriteTokens
    stats.outputTokens += outputTokens
    stats.lastRequestInputTokens = totalInputLength

    if (found) {
      stats.requestCount += 1
      stats.cost[currency] = (stats.cost[currency] ?? 0) + cost
      const periodSplit = stats.byPeriod[currency] ?? { offPeak: 0, peak: 0 }
      if (period === 'peak') periodSplit.peak += cost
      else periodSplit.offPeak += cost
      stats.byPeriod[currency] = periodSplit
      if (modelHasPeriods(table, config.provider, config.model, config.reasoningEffort)) {
        stats.hasPeakConfig = true
        const key = peakKey(config.provider, config.model, config.reasoningEffort)
        if (!stats.peakModels.includes(key)) stats.peakModels.push(key)
      }
    } else {
      stats.unpricedRequestCount += 1
    }

    // One row per request, priced the same way the totals are. Unpriced
    // requests still record their real tokens (priced: false, cost 0) so the
    // detail matches the totals; they keep the provider's currency so
    // turn-level aggregation groups them with the right bucket. Truncation
    // to RECENT_TURNS_CAP happens in the projection apply wrapper — the fold
    // keeps full history for the turns route.
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
      cost: found ? cost : 0,
      currency,
      period,
      priced: found,
    })

    const totalInput = stats.uncachedInputTokens + stats.cacheReadTokens
    stats.cacheHitRate = totalInput > 0 ? stats.cacheReadTokens / totalInput : 0
    return { config, stats }
  }
  if (event.type === 'compaction/summary') {
    // A successful compaction's shadow price: the exact heuristic tokens of
    // the replaced range. Plus — when the provider reported it — the REAL
    // usage of the summarization call itself: it is a one-shot ctx.llm.stream
    // request that produces no assistant/message, so without folding it here
    // its (often large) cost would vanish from the session entirely. Its cost
    // joins the session totals; its tokens stay OUT of the conversation
    // buckets (a one-shot re-read of the compacted range would wreck the
    // cache-hit-rate semantics) and are accumulated on compactions instead.
    const stats = cloneStats(state.stats)
    stats.compactions = {
      ...stats.compactions,
      count: stats.compactions.count + 1,
      lastTime: event.time,
      lastShadowedTokens: event.data.shadowedTokenCount,
    }
    const usage = event.data.usage
    if (usage !== undefined) {
      const { provider, model } = event.data
      const cacheReadTokens = usage.cacheReadTokens ?? 0
      const cacheWriteTokens = usage.cacheWriteTokens ?? 0
      const { priceUnits: cost, currency, period, found } = priceRequest(
        table, provider, model, undefined, event.time,
        { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens, cacheWriteTokens },
      )
      stats.compactions.tokens += usage.inputTokens + cacheReadTokens + cacheWriteTokens + usage.outputTokens
      if (found) {
        stats.requestCount += 1
        stats.cost[currency] = (stats.cost[currency] ?? 0) + cost
        stats.compactions.cost[currency] = (stats.compactions.cost[currency] ?? 0) + cost
        const periodSplit = stats.byPeriod[currency] ?? { offPeak: 0, peak: 0 }
        if (period === 'peak') periodSplit.peak += cost
        else periodSplit.offPeak += cost
        stats.byPeriod[currency] = periodSplit
        if (modelHasPeriods(table, provider, model, undefined)) {
          stats.hasPeakConfig = true
          const key = peakKey(provider, model, undefined)
          if (!stats.peakModels.includes(key)) stats.peakModels.push(key)
        }
      } else {
        stats.unpricedRequestCount += 1
      }
    }
    return { config: state.config, stats }
  }
  return state
}

/** Fold an entire event log from the empty state. */
export function foldBilling(
  events: readonly SessionEvent[],
  table: PriceTable,
): SessionBillingStats {
  let state: BillingFoldState = { config: undefined, stats: EMPTY_STATS }
  for (const event of events) state = foldEvent(state, event, table)
  return state.stats
}

/** Bound a `turns` array to the most recent RECENT_TURNS_CAP conversation
 *  TURNS, keeping every request of the kept turns (a turn with many
 *  tool-calling steps keeps all its requests). Truncation is per-turn so the
 *  turn-aggregated views see the same recent turns as the request view.
 *  Turns are keyed by turn NUMBER alone: a turn that bills in several
 *  currencies (one row per currency) still counts as ONE turn — keying by
 *  turn:currency would silently halve the window for multi-currency
 *  sessions. */
export function boundTurns(turns: readonly TurnCost[]): TurnCost[] {
  if (turns.length <= RECENT_TURNS_CAP) return [...turns]
  const kept: TurnCost[] = []
  const seenTurns = new Set<number>()
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!
    if (!seenTurns.has(t.turn)) {
      if (seenTurns.size >= RECENT_TURNS_CAP) break
      seenTurns.add(t.turn)
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
