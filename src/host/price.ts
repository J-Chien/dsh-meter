/**
 * Billing price model: per-model price tables with per-provider currency and
 * optional peak/off-peak windows.
 *
 * Price storage uses a fixed decimal basis to avoid floating-point drift:
 * every per-million-token price is stored as an integer number of
 * `PRICE_PRECISION`ths of the configured currency unit (default 1/100000 of
 * a yuan, i.e. 0.00001). This keeps 4-decimal prices like ¥10.1550/M exact.
 */
import { findPriceRow, inPeakWindow, isHolidayAt, PRICE_PRECISION, type ModelPrice, type PeakPeriod, type PriceTable, type PriceTier } from '../shared.ts'

export { findPriceRow, inPeakWindow, isHolidayAt, PRICE_PRECISION, formatPrice, type ModelPrice, type PeakPeriod, type PriceTable, type PriceTier } from '../shared.ts'

/** One model's effective price for a given instant, in price units. */
export interface EffectivePrice {
  input: number
  output: number
  cacheInput: number
  cacheWrite: number
  /** Which period matched: 'off-peak' (default) or 'peak'. A calendar holiday
   *  is OFF-PEAK — that is what the provider's rule says it is. */
  period: 'off-peak' | 'peak'
  /**
   * True when a calendar holiday is what kept this instant out of its peak
   * window. Reported separately from `period` only so tooling (the self-check
   * CLI, and any future "节假日" label) can SHOW why the price is the off-peak
   * one; nothing about the price depends on the distinction.
   */
  holiday: boolean
  /** Whether a price row exists for the model at all. */
  found: boolean
}

/** Whether any configured peak period is active at `timeMs`, judged in the
 *  provider's timezone (absent → DEFAULT_TIMEZONE via inPeakWindow). */
function activePeriod(row: ModelPrice, timeMs: number, timezone?: string): PeakPeriod | undefined {
  if (row.periods === undefined) return undefined
  for (const period of row.periods) {
    if (inPeakWindow(period, timeMs, timezone)) return period
  }
  return undefined
}

/**
 * The INDEX of the tier whose ranges contain the request's total lengths, or
 * -1 when none matches. Ranges are half-open: a request with exactly 32000
 * input tokens does NOT match a tier whose `inputMax` is 32000.
 *
 * A tier with NO range bounds at all (inputMin/Max and outputMin/Max all
 * absent) is the "all lengths" fallback: it matches any request, so it is
 * only used when no range-constrained tier matched. This lets the default
 * tier (first in the list, often unbounded) act as the catch-all while
 * specific length tiers take precedence.
 */
function tierIndex(tiers: readonly PriceTier[] | undefined, totalInput: number, output: number): number {
  if (tiers === undefined) return -1
  let fallback = -1
  for (let i = 0; i < tiers.length; i += 1) {
    const tier = tiers[i] as PriceTier | undefined
    if (tier === undefined) continue
    const hasRange = tier.inputMin !== undefined || tier.inputMax !== undefined
      || tier.outputMin !== undefined || tier.outputMax !== undefined
    if (!hasRange) {
      // The all-lengths tier is the last-resort fallback, not a first match.
      if (fallback < 0) fallback = i
      continue
    }
    if (tier.inputMin !== undefined && totalInput < tier.inputMin) continue
    if (tier.inputMax !== undefined && totalInput >= tier.inputMax) continue
    if (tier.outputMin !== undefined && output < tier.outputMin) continue
    if (tier.outputMax !== undefined && output >= tier.outputMax) continue
    return i
  }
  return fallback
}

/** The first tier whose ranges contain the request's total lengths, or undefined. */
function matchTier(tiers: readonly PriceTier[] | undefined, totalInput: number, output: number): PriceTier | undefined {
  const index = tierIndex(tiers, totalInput, output)
  return index >= 0 ? tiers?.[index] : undefined
}

/** Extract the 4 per-M prices from a period/tier, defaulting cacheWrite to 0. */
function fourPrices(
  p: Pick<PeakPeriod | PriceTier, 'input' | 'output' | 'cacheInput' | 'cacheWrite'>,
): { input: number; output: number; cacheInput: number; cacheWrite: number } {
  return { input: p.input, output: p.output, cacheInput: p.cacheInput, cacheWrite: p.cacheWrite ?? 0 }
}

/**
 * Resolve the effective price for one model at one instant.
 * Resolution order: an active peak period uses ITS per-tier prices, matched
 * by index against the model's base tier RANGES (then the period's flat
 * price); otherwise the model's length tiers (then the base prices).
 * Returns `found: false` (zero prices) when the model has no price row.
 */
export function effectivePrice(
  table: PriceTable,
  provider: string,
  model: string,
  reasoningEffort: string | undefined,
  timeMs: number,
  totalInput = 0,
  output = 0,
): EffectivePrice {
  const row = findPriceRow(table, provider, model, reasoningEffort)
  if (row === undefined) {
    return { input: 0, output: 0, cacheInput: 0, cacheWrite: 0, period: 'off-peak', holiday: false, found: false }
  }
  const timezone = table.providers[provider]?.timezone
  // A statutory holiday suspends the day's peak windows entirely (the provider's
  // rule: 高峰 = 周一至周五 不含法定节假日), so it is checked BEFORE the windows.
  // Only reported as a holiday effect when the row actually has windows to
  // suspend — a flat-priced row is unaffected either way.
  const hasWindows = row.periods !== undefined && row.periods.length > 0
  const holiday = hasWindows && isHolidayAt(table, provider, timeMs)
  const period = holiday ? undefined : activePeriod(row, timeMs, timezone)
  if (period !== undefined) {
    // Period tiers align by index with the base tier RANGES.
    if (period.tiers !== undefined && period.tiers.length > 0) {
      const index = tierIndex(row.tiers, totalInput, output)
      const periodTier = index >= 0 ? period.tiers[index] : undefined
      if (periodTier !== undefined) return { ...fourPrices(periodTier), period: 'peak', holiday: false, found: true }
    }
    return { ...fourPrices(period), period: 'peak', holiday: false, found: true }
  }
  const tier = matchTier(row.tiers, totalInput, output)
  if (tier !== undefined) {
    return { ...fourPrices(tier), period: 'off-peak', holiday, found: true }
  }
  return { ...fourPrices(row), period: 'off-peak', holiday, found: true }
}

/** Price one token bucket at a per-M price. All quantities are integers.
 *  A non-finite argument prices at 0: `tokens <= 0` / `perMTokens <= 0` do not
 *  reject NaN (every comparison with NaN is false), and returning
 *  `Math.floor(tokens * NaN / 1e6)` would put NaN into the totals, the wire
 *  view and every rendered cost. */
export function priceTokens(tokens: number, perMTokens: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(perMTokens)) return 0
  if (tokens <= 0 || perMTokens <= 0) return 0
  // tokens/1e6 * perMTokens/PRICE_PRECISION currency units → price units.
  return Math.floor((tokens * perMTokens) / 1_000_000)
}

/**
 * Price one request's usage at the model's effective price for its instant.
 * @returns { priceUnits, currency, period, found } — `currency` is the
 * provider's configured currency code, defaulting to 'CNY' when the provider
 * has no entry in the table (priceRequest still prices the row; the fallback
 * keeps the cost keyed under a real currency rather than '').
 */
export function priceRequest(
  table: PriceTable,
  provider: string,
  model: string,
  reasoningEffort: string | undefined,
  timeMs: number,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): {
  priceUnits: number
  currency: string
  period: 'off-peak' | 'peak'
  /** See {@link EffectivePrice.holiday}. */
  holiday: boolean
  found: boolean
} {
  const uncachedInputTokens = usage.inputTokens
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const outputTokens = usage.outputTokens
  const totalInput = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  const eff = effectivePrice(table, provider, model, reasoningEffort, timeMs, totalInput, outputTokens)
  const priceUnits = priceTokens(uncachedInputTokens, eff.input)
    + priceTokens(cacheReadTokens, eff.cacheInput)
    + priceTokens(cacheWriteTokens, eff.cacheWrite)
    + priceTokens(outputTokens, eff.output)
  const currency = table.providers[provider]?.currency ?? 'CNY'
  return { priceUnits, currency, period: eff.period, holiday: eff.holiday, found: eff.found }
}

/** Whether every resolved rate on one row is finite (period/tier rates too). */
function hasOnlyFiniteRates(row: ModelPrice): boolean {
  const finite = (value: number | undefined): boolean => value === undefined || Number.isFinite(value)
  if (!finite(row.input) || !finite(row.output) || !finite(row.cacheInput) || !finite(row.cacheWrite)) return false
  for (const period of row.periods ?? []) {
    if (!finite(period.input) || !finite(period.output) || !finite(period.cacheInput) || !finite(period.cacheWrite)) return false
    for (const tier of period.tiers ?? []) {
      if (!finite(tier.input) || !finite(tier.output) || !finite(tier.cacheInput) || !finite(tier.cacheWrite)) return false
    }
  }
  for (const tier of row.tiers ?? []) {
    if (!finite(tier.input) || !finite(tier.output) || !finite(tier.cacheInput) || !finite(tier.cacheWrite)) return false
  }
  return true
}

/**
 * Drop every row whose resolved rates are not all finite.
 *
 * The profile-patch layer reaches the resolved table without passing through
 * the price-file loader, so a hand-written patch can carry a NaN/±Infinity
 * where the schema's `min(0)` checks let it through (every comparison with
 * NaN is false). Letting one become a table value would throw inside the
 * host's per-committed-event projection loop — `wire.viewSchema.parse` runs
 * there with no try/catch — taking every further frame of that session down.
 * The row fails CLOSED here instead, at the last point before it is folded.
 *
 * @param table - the resolved table.
 * @returns the table minus the bad rows, plus their `provider/model` labels.
 */
export function dropNonFiniteRows(table: PriceTable): { table: PriceTable; dropped: string[] } {
  const dropped: string[] = []
  const models = table.models.filter(row => {
    if (hasOnlyFiniteRates(row)) return true
    dropped.push(`${row.provider}/${row.model}`)
    return false
  })
  return { table: dropped.length === 0 ? table : { ...table, models }, dropped }
}
