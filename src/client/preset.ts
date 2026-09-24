/**
 * The official DeepSeek peak rule as a pure transform over one model's peak
 * windows, extracted from the settings card so the rule is testable without a
 * DOM. The button's contract is "make this model's weekday peaks match
 * DeepSeek's published pair", and getting it wrong is not cosmetic: a dropped
 * window is a silent price change.
 *
 * The regression this module exists to prevent: an earlier in-component
 * version kept only the FIRST weekday window, so pressing the preset on a
 * correctly configured DeepSeek row deleted 14:00–18:00 and halved the peak
 * coverage.
 */
import { DEEPSEEK_PEAK_WINDOWS, WEEKDAY_DAYS } from '../shared.ts'
import type { PeakPeriod, PriceTier } from '../shared.ts'

/** Off-peak prices a synthesized window inherits (never invented). */
export interface OfficialBasePrice {
  input: number
  output: number
  cacheInput: number
  cacheWrite?: number
}

/** Deep copy one window, so callers keep their immutability story. */
function clone(period: PeakPeriod): PeakPeriod {
  return {
    ...period,
    ...(period.days !== undefined ? { days: [...period.days] } : {}),
    ...(period.tiers !== undefined ? { tiers: period.tiers.map(tier => ({ ...tier })) } : {}),
  }
}

/** Whether a window applies to weekdays only (the official rule's day shape). */
function isWeekdayOnly(period: PeakPeriod, weekdays: readonly number[]): boolean {
  return period.days !== undefined && period.days.length > 0
    && period.days.every(day => weekdays.includes(day))
}

/**
 * Remap one model's peak windows onto DeepSeek's official weekday rule.
 *
 * EVERY weekday-only window is KEPT and re-masked onto Mon–Fri: the official
 * rule is TWO windows (09:00–12:00 and 14:00–18:00), so keeping only the first
 * would silently drop the afternoon peak. Windows that are not weekday-only
 * (weekend windows, all-day windows, an absent `days`) are left untouched.
 *
 * A model with no weekday window at all is seeded with the official pair,
 * priced at its current off-peak rate: the preset must never invent a price
 * the user did not set.
 *
 * @param periods - the model's current peak windows.
 * @param base - the model's off-peak prices, for a seeded window.
 * @param tiers - the model's base tiers, mirrored into a seeded window.
 * @returns a fresh period list; the inputs are not mutated.
 */
export function officialPeakPeriods(
  periods: readonly PeakPeriod[],
  base: OfficialBasePrice,
  tiers: readonly PriceTier[] = [],
): PeakPeriod[] {
  const weekdays = [...WEEKDAY_DAYS]
  const rest = periods.filter(period => !isWeekdayOnly(period, weekdays)).map(clone)
  const weekday = periods.filter(period => isWeekdayOnly(period, weekdays))
    .map(period => ({ ...clone(period), days: [...weekdays] }))
  if (weekday.length > 0) return [...rest, ...weekday]
  const seeded: PeakPeriod[] = DEEPSEEK_PEAK_WINDOWS.map(([startHour, endHour]) => ({
    startHour,
    endHour,
    days: [...weekdays],
    input: base.input,
    output: base.output,
    cacheInput: base.cacheInput,
    ...(base.cacheWrite !== undefined ? { cacheWrite: base.cacheWrite } : {}),
    tiers: tiers.map(tier => ({ ...tier })),
  }))
  return [...rest, ...seeded]
}
