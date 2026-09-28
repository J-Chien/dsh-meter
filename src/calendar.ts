/**
 * Billing calendars: the statutory-holiday dates on which a provider's peak
 * windows do NOT apply.
 *
 * WHY A DATE LIST AND NOT A "WORKDAY LIBRARY": the rule this serves is the
 * PROVIDER's published one. DeepSeek defines 高峰时段 as 「北京时间周一至周五
 * （不含中国法定节假日）9:00-12:00、14:00-18:00」. China's arrangement also moves
 * weekend days INTO workdays (调休), and a workday library would call those
 * peak — the opposite of the published rule (in 2026 all six 调休 days are
 * weekends, so every one of them is a day the provider charges off-peak).
 * Modelling the 放假日 list — and nothing else — is therefore not a
 * simplification, it is the correct reading. It also happens to be small:
 * ~33 dates/year of which ~19 are weekdays (only those can ever matter).
 *
 * Dates are LOCAL calendar dates in the provider's own clock, never UTC
 * instants: `2026-10-01` means that date in `providers.<id>.timezone`, so the
 * check must be made against the same `wallClock` the peak windows use.
 */

/** One `YYYY-MM-DD` or an inclusive `YYYY-MM-DD..YYYY-MM-DD` range, as written. */
const CALENDAR_ENTRY = /^(\d{4})-(\d{2})-(\d{2})(?:\.\.(\d{4})-(\d{2})-(\d{2}))?$/

/** Days in one month of a (proleptic Gregorian) year. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Whether `year-month-day` is a real calendar date (rejects 2026-02-30). */
export function isIsoDate(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Expand written calendar entries into sorted, de-duplicated `YYYY-MM-DD`
 * dates. Ranges are inclusive and may span months and years; every endpoint
 * must be a real date and the range must not run backwards.
 *
 * Accepts a `Date` as well as a string, because YAML types an UNQUOTED
 * `2026-10-01` as a date, not a string — the single most likely thing a writer
 * does, and rejecting it would be a format trap. The date is taken back from
 * the value's UTC parts, which is exactly what YAML's date resolver parsed, so
 * the written day survives regardless of the host's timezone. (Quoting is still
 * allowed and always means "this literal string".)
 *
 * @param entries - what a file or a config layer wrote.
 * @returns the expanded dates plus one message per rejected entry. Nothing is
 *   returned when any entry is unreadable: a half-read calendar would silently
 *   mis-price the days it swallowed.
 */
export function expandCalendarDates(entries: readonly unknown[]): { dates: string[]; errors: string[] } {
  const errors: string[] = []
  const dates = new Set<string>()
  for (const raw of entries) {
    const entry = raw instanceof Date
      ? raw.toISOString().slice(0, 10)
      : typeof raw === 'string'
        ? raw.trim()
        : String(raw)
    const match = CALENDAR_ENTRY.exec(entry)
    if (match === null) {
      errors.push(`"${entry}" is not a date (YYYY-MM-DD) or an inclusive range (YYYY-MM-DD..YYYY-MM-DD)`
        + (typeof raw === 'number' ? ' — a bare number is not a date' : ''))
      continue
    }
    const [, y1, m1, d1, y2, m2, d2] = match
    const start = { year: Number(y1), month: Number(m1), day: Number(d1) }
    if (!isIsoDate(start.year, start.month, start.day)) {
      errors.push(`"${entry}" is not a real calendar date`)
      continue
    }
    const end = y2 === undefined
      ? start
      : { year: Number(y2), month: Number(m2), day: Number(d2) }
    if (!isIsoDate(end.year, end.month, end.day)) {
      errors.push(`"${entry}" ends on a date that does not exist`)
      continue
    }
    const from = Date.UTC(start.year, start.month - 1, start.day)
    const to = Date.UTC(end.year, end.month - 1, end.day)
    if (to < from) {
      errors.push(`"${entry}" runs backwards`)
      continue
    }
    // Ranges are calendar-day spans, so plain UTC arithmetic is exact here —
    // no DST or offset enters a date-only comparison.
    for (let t = from; t <= to; t += 86_400_000) {
      const at = new Date(t)
      dates.add(iso(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()))
    }
  }
  return { dates: [...dates].sort(), errors }
}

/** What a calendar covers, for the "is this year priced?" report. */
export interface CalendarCoverage {
  /** Names of the calendars in play, in declaration order. */
  readonly names: readonly string[]
  /** Total distinct dates across those calendars. */
  readonly count: number
  /** Distinct dates per calendar name. */
  readonly byName: Record<string, number>
  /** Earliest and latest dates, when any exist. */
  readonly from?: string
  readonly to?: string
  /**
   * Which years the dates cover, so a caller can say "2027 未覆盖" instead of
   * letting holidays silently price as peak.
   */
  readonly years: readonly number[]
}

/**
 * Describe calendars for the settings card and the self-check CLI. Entries may
 * be written as ranges (humans write `2026-10-01..2026-10-07`), so they are
 * expanded first — otherwise the reported window would be built from range
 * STRINGS and read as nonsense ("2025-01-01..2026-10-01..2026-10-07").
 * @param calendars - calendars as declared, ranges allowed.
 * @returns coverage across all calendars plus a distinct-date count per name.
 */
export function calendarCoverage(calendars: Record<string, readonly string[]> | undefined): CalendarCoverage {
  const names = Object.keys(calendars ?? {})
  const all = new Set<string>()
  const byName: Record<string, number> = {}
  for (const [name, entries] of Object.entries(calendars ?? {})) {
    const { dates } = expandCalendarDates(entries)
    byName[name] = dates.length
    for (const date of dates) all.add(date)
  }
  const sorted = [...all].sort()
  const years = new Set<number>()
  for (const date of sorted) years.add(Number(date.slice(0, 4)))
  return {
    names,
    count: sorted.length,
    byName,
    ...(sorted.length === 0 ? {} : { from: sorted[0], to: sorted[sorted.length - 1] }),
    years: [...years].sort(),
  }
}
