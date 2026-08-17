/**
 * Billing price model: per-model price tables with per-provider currency and
 * optional peak/off-peak windows.
 *
 * Price storage uses a fixed decimal basis to avoid floating-point drift:
 * every per-million-token price is stored as an integer number of
 * `PRICE_PRECISION`ths of the configured currency unit (default 1/100000 of
 * a yuan, i.e. 0.00001). This keeps 4-decimal prices like ¥10.1550/M exact.
 */
import { inPeakWindow, PRICE_PRECISION, type ModelPrice, type PeakPeriod, type PriceTable, type PriceTier } from '../shared.ts'

export { inPeakWindow, PRICE_PRECISION, formatPrice, type ModelPrice, type PeakPeriod, type PriceTable, type PriceTier } from '../shared.ts'

/** One model's effective price for a given instant, in price units. */
export interface EffectivePrice {
  input: number
  output: number
  cacheInput: number
  cacheWrite: number
  /** Which period matched: 'off-peak' (default) or 'peak'. */
  period: 'off-peak' | 'peak'
  /** Whether a price row exists for the model at all. */
  found: boolean
}

/** Whether any configured peak period is active at `timeMs`. */
function activePeriod(row: ModelPrice, timeMs: number): PeakPeriod | undefined {
  if (row.periods === undefined) return undefined
  for (const period of row.periods) {
    if (inPeakWindow(period, timeMs)) return period
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
  const row = table.models.find(
    m => m.provider === provider
      && m.model === model
      && (reasoningEffort === undefined || m.reasoningEffort === undefined || m.reasoningEffort === reasoningEffort),
  )
  if (row === undefined) {
    return { input: 0, output: 0, cacheInput: 0, cacheWrite: 0, period: 'off-peak', found: false }
  }
  const period = activePeriod(row, timeMs)
  if (period !== undefined) {
    // Period tiers align by index with the base tier RANGES.
    if (period.tiers !== undefined && period.tiers.length > 0) {
      const index = tierIndex(row.tiers, totalInput, output)
      const periodTier = index >= 0 ? period.tiers[index] : undefined
      if (periodTier !== undefined) return { ...fourPrices(periodTier), period: 'peak', found: true }
    }
    return { ...fourPrices(period), period: 'peak', found: true }
  }
  const tier = matchTier(row.tiers, totalInput, output)
  if (tier !== undefined) {
    return { ...fourPrices(tier), period: 'off-peak', found: true }
  }
  return { ...fourPrices(row), period: 'off-peak', found: true }
}

/** Price one token bucket at a per-M price. All quantities are integers. */
export function priceTokens(tokens: number, perMTokens: number): number {
  if (tokens <= 0 || perMTokens <= 0) return 0
  // tokens/1e6 * perMTokens/PRICE_PRECISION currency units → price units.
  return Math.floor((tokens * perMTokens) / 1_000_000)
}

/**
 * Price one request's usage at the model's effective price for its instant.
 * @returns { priceUnits, currency, period, found } — `currency` is the
 * provider's configured currency code ('' when the provider is unconfigured).
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
  return { priceUnits, currency, period: eff.period, found: eff.found }
}
