/**
 * The official DeepSeek peak rule as a pure transform over one model's peak
 * windows, extracted from the settings card so the rule is testable without a
 * DOM. The button's contract is "make this model's weekday peaks BE DeepSeek's
 * published pair", and getting it wrong is not cosmetic: a dropped window is a
 * silent price change.
 *
 * Two regressions this module exists to prevent:
 *  - an earlier in-component version kept only the FIRST weekday window, so
 *    pressing the preset on a correctly configured DeepSeek row deleted
 *    14:00–18:00 and halved the peak coverage;
 *  - the next version re-masked every weekday window's DAYS but never its
 *    HOURS, so a model whose only weekday window was 10:00–11:00 ended up with
 *    NEITHER official window while the button still claimed "official rules".
 *
 * The rule now reshapes hours as well: the model's weekday peaks become exactly
 * DeepSeek's two windows. A non-official weekday window cannot be kept as
 * "extra hours" without ambiguity — its hours would overlap an official window
 * that may carry a different peak price — so it is replaced. Its PRICE is
 * reused for an official window that has no exact-hours match; only a model
 * with no weekday window at all is seeded from its off-peak rate, so the
 * preset never invents a price the user did not set.
 *
 * Windows that are not weekday-only (weekend, all-day, an absent `days`) are
 * left exactly as they are: the official rule says nothing about them.
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
 * EVERY weekday-only window is folded into the official pair: a window whose
 * hours already match an official window keeps its own prices (and is merely
 * re-masked onto Mon–Fri), while an official window no existing window matches
 * is seeded from the model's existing peak prices. With no weekday window at
 * all, both windows are seeded from the model's off-peak rate and the base
 * tier structure. Windows that are not weekday-only are left untouched.
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
  // Price source for an official window without an exact-hours match: the first
  // existing weekday window (its peak prices are the user's own), else the
  // off-peak base — never an invented number. The first window is the
  // deterministic choice; when several differ the preset cannot know which the
  // user means, and the button's contract is the official SHAPE.
  const priceSource: OfficialBasePrice = weekday[0] ?? base
  const sourceTiers: readonly PriceTier[] = weekday[0]?.tiers ?? tiers
  const official = DEEPSEEK_PEAK_WINDOWS.map(([startHour, endHour]): PeakPeriod => {
    const match = weekday.find(period => period.startHour === startHour && period.endHour === endHour)
    if (match !== undefined) return { ...clone(match), days: [...weekdays] }
    return {
      startHour,
      endHour,
      days: [...weekdays],
      input: priceSource.input,
      output: priceSource.output,
      cacheInput: priceSource.cacheInput,
      ...(priceSource.cacheWrite !== undefined ? { cacheWrite: priceSource.cacheWrite } : {}),
      tiers: sourceTiers.map(tier => ({ ...tier })),
    }
  })
  return [...rest, ...official]
}
