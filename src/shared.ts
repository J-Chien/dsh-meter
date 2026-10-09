/**
 * Wire shapes shared (via local copy) by the host fold and the client UI.
 * Plain JSON, deliberately independent of @deepseek-ai packages so both
 * halves can import it without crossing the bundle purity gate.
 */

import { expandCalendarDates } from './calendar.ts'

/** The Host plugin entry id carrying the price table (the entry's volatile
 *  Config IS the table — keep host watcher and client binding on this). */
export const BILLING_ENTRY_ID = 'billing'

/**
 * One input/output-length price tier (e.g. z.ai GLM tiered billing).
 * A request's TOTAL input length (uncached + cache read + cache write) and
 * output length pick the FIRST tier whose ranges contain them; a request
 * matching no tier falls back to the owning block's flat price. All lengths
 * are raw token counts; a bound of 32000 means 32K tokens.
 *
 * The tier RANGES live only on the model's base tier list (`ModelPrice.tiers`).
 * A peak period's `tiers` entries are the SAME length, aligned by index, and
 * carry only prices (ranges ignored) — the period reuses the base ranges.
 */
export interface PriceTier {
  /** Inclusive input lower bound; absent = 0. */
  inputMin?: number
  /** Exclusive input upper bound; absent = unbounded. */
  inputMax?: number
  /** Inclusive output lower bound; absent = 0. */
  outputMin?: number
  /** Exclusive output upper bound; absent = unbounded. */
  outputMax?: number
  /** Prices while this tier applies, per million tokens. */
  input: number
  output: number
  cacheInput: number
  /**
   * Per-M price of writing a cache entry; absent = 0 (not billed separately).
   * A single scalar because the durable log currently carries only the total
   * cache-write token count — providers that split writes by TTL (e.g.
   * Anthropic's `cache_creation.ephemeral_5m/1h_input_tokens`) are not yet
   * surfaced, so per-TTL prices cannot be matched to usage. When that split
   * flows, extend this to a `Record<ttl, number>` (see PRD §8).
   */
  cacheWrite?: number
}

/** One configured peak/off-peak price period for a model. */
export interface PeakPeriod {
  /** Local hour the window starts (0-23). */
  startHour: number
  /** Local hour the window ends (1-24; a lower end than start = overnight). */
  endHour: number
  /** Day-of-week mask (0=Sunday … 6=Saturday); absent = every day. */
  days?: number[]
  /** Prices while the period is active, per million tokens. */
  input: number
  output: number
  cacheInput: number
  /** Per-M price of writing a cache entry; absent = 0 (not billed separately). */
  cacheWrite?: number
  /**
   * The period's per-tier peak prices, aligned BY INDEX with the model's
   * base `tiers` (same length; ranges come from the base list). A new peak
   * period is created as a copy of the base tiers' structure with the
   * period's flat prices pre-filled; while the period is active, matching
   * tiers use these prices and the flat price is the fallback.
   */
  tiers?: PriceTier[]
}

/** One model's price row. All prices are per million tokens. */
export interface ModelPrice {
  provider: string
  model: string
  reasoningEffort?: string
  /** Off-peak (default) per-M prices. Doubles as the default when no tier matches. */
  input: number
  output: number
  cacheInput: number
  /** Per-M cache-write price; absent = 0 (not billed separately). */
  cacheWrite?: number
  /** Optional peak/off-peak windows; absent = always the default price. */
  periods?: PeakPeriod[]
  /** Optional length-based price tiers; absent = no tiering. */
  tiers?: PriceTier[]
}

/** IANA timezone a provider's peak windows are judged in when it sets none.
 *  DeepSeek bills by Beijing time, so the default follows that habit. */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai'

/** Day-of-week mask for weekdays (0=Sunday … 6=Saturday): Mon–Fri. */
export const WEEKDAY_DAYS = [1, 2, 3, 4, 5]

/** Provider id of DeepSeek's official API (the API-key route). */
export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official'

/**
 * Provider ids of DeepSeek's OWN API, in both routes: the API-key route and
 * the signed-in account route. One upstream service, one price list, one peak
 * rule — so anything keyed to "official DeepSeek" must accept both, or the
 * account route silently loses the affordance the API-key route gets.
 */
export const DEEPSEEK_PROVIDER_IDS: readonly string[] = [DEEPSEEK_OFFICIAL_PROVIDER, 'deepseek-account']

/**
 * DeepSeek's published peak windows in the provider's local clock: 09:00–12:00
 * and 14:00–18:00. The day mask is the caller's (the official rule is
 * weekdays); everything outside them is 空闲时段, published at half the peak
 * rate. Single source for the built-in table AND the settings card's
 * official-rule preset, so the two cannot disagree about what "official" means.
 */
export const DEEPSEEK_PEAK_WINDOWS: readonly (readonly [number, number])[] = [[9, 12], [14, 18]]

/** Per-provider currency selection. */
export interface ProviderCurrency {
  currency: 'CNY' | 'USD'
  currencySymbol: string
  /**
   * Name of the calendar in `PriceTable.calendars` this provider observes, e.g.
   * `cn`. On those LOCAL dates every peak window is suspended for the whole day
   * (see calendar.ts for why only the 放假日 list is modelled). Absent = the
   * provider is never treated as being on holiday, which is the honest default:
   * a gateway's peak windows are whatever its operator configured.
   */
  calendar?: string
  /**
   * IANA timezone name (e.g. "Asia/Shanghai") for judging this provider's
   * peak windows. Absent = DEFAULT_TIMEZONE. One provider may span regions
   * and another may bill in a different timezone, so each provider carries
   * its own clock — a request priced at peak in one provider's window is
   * off-peak in another's without either being "wrong".
   */
  timezone?: string
}

/**
 * Host-reported state of the agent-writable price file (docs/CONFIGURING.md).
 * The settings card shows it so a file that supplies prices is never invisible:
 * a table whose rows come from a file looks identical to one typed by hand.
 */
export interface PriceFileStatus {
  /** Absolute path the host read (or tried to read). */
  path: string
  /** Whether the file exists; a missing file is the normal case. */
  present: boolean
  /** Model rows the file declares. */
  rows: number
  /** Of those, how many an explicit entry config overrides (price NOT in effect). */
  overridden: number
  /** Fatal problems; when non-empty the file was ignored whole. */
  errors: string[]
}

/**
 * Host-reported holiday-calendar state, so the settings card and the self-check
 * CLI can SHOW what the calendar does and does not cover. A stale calendar is
 * the failure mode of this feature — it silently bills holidays at peak — so
 * the coverage travels with the table instead of living only in a code comment.
 */
export interface CalendarStatus {
  /** Calendar names in the table, in declaration order. */
  names: string[]
  /** Distinct holiday dates across all calendars. */
  dates: number
  /** Coverage window, absent when no calendar has a date. */
  from?: string
  to?: string
  /** Years the dates cover, ascending. */
  years: number[]
  /**
   * Providers naming a calendar no calendar declares. Reported rather than
   * ignored: the provider would never observe a holiday, and the price-file
   * loader only validates the FILE (a hand-written patch layer can still get
   * this wrong).
   */
  missing: { provider: string; calendar: string }[]
  /**
   * Calendar entries the compiler could not read (a typo'd date, a bare
   * number). Reported so a broken date is a visible gap rather than a holiday
   * that quietly bills at peak.
   */
  invalid: string[]
}

/** The resolved price configuration (what the settings page edits). */
export interface PriceTable {
  /** Currency per provider (providers may bill in different currencies). */
  providers: Record<string, ProviderCurrency>
  models: ModelPrice[]
  /**
   * Statutory-holiday calendars by name, each a list of LOCAL `YYYY-MM-DD`
   * dates (ranges are expanded on load). A provider opts in by naming one in
   * `providers.<id>.calendar`; a calendar nobody references costs nothing.
   */
  calendars?: Record<string, string[]>
}

/**
 * The wall-clock hour (0-23) and weekday (0=Sunday … 6=Saturday) of an
 * instant in a timezone, via cached `Intl.DateTimeFormat` parts.
 *
 * Cached per timezone: window checks run on every priced request, so the
 * formatter must not be reconstructed each call.
 */
const tzFormatters = new Map<string, Intl.DateTimeFormat>()
const tzCache = new Map<string, { hour: number; day: number; date: string; minute: number }>()
function wallClock(timeMs: number, timezone: string): { hour: number; day: number; date: string } {
  let formatter = tzFormatters.get(timezone)
  if (formatter === undefined) {
    // A corrupted table could carry an unparseable timezone; degrade to the
    // default rather than throwing out of the whole fold.
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, weekday: 'short', hour: '2-digit', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
      })
    } catch {
      return wallClock(timeMs, DEFAULT_TIMEZONE)
    }
    tzFormatters.set(timezone, formatter)
  }
  let cached = tzCache.get(timezone)
  if (cached === undefined) {
    cached = { hour: -1, day: -1, date: '', minute: -1 }
    tzCache.set(timezone, cached)
  }
  // The cache keys by the wall-clock minute: an instant that re-reads the
  // same minute (same hour + same weekday) reuses the parsed parts.
  const minute = Math.floor(timeMs / 60_000)
  if (cached.hour === -1 || cached.minute !== minute) {
    const parts = formatter.formatToParts(timeMs)
    let hour = 0
    let day = 0
    let year = ''
    let month = ''
    let date = ''
    for (const part of parts) {
      if (part.type === 'hour') hour = Number(part.value) % 24
      else if (part.type === 'weekday') day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part.value)
      else if (part.type === 'year') year = part.value
      else if (part.type === 'month') month = part.value
      else if (part.type === 'day') date = part.value
    }
    cached.hour = hour
    cached.day = day
    // Same call, same cache: the local calendar date a holiday is keyed by.
    cached.date = `${year}-${month}-${date}`
    cached.minute = minute
  }
  return { hour: cached.hour, day: cached.day, date: cached.date }
}

/** Whether a wall-clock instant falls inside a peak window. Shared by the
 *  host fold and the client "currently in peak" hint so window semantics
 *  stay single-source.
 *
 *  `timezone` (a provider-level clock, typically the provider's own
 *  `timezone` setting) decides the hour AND the weekday: DeepSeek bills in
 *  Beijing time, so a window configured for Asia/Shanghai must open at
 *  09:00 in Shanghai, not at 09:00 wherever the host runs. Absent/empty
 *  falls back to DEFAULT_TIMEZONE (Asia/Shanghai) — the DeepSeek habit and
 *  the historical default for existing configs.
 *
 *  `days` filters by the window's START day: an overnight window (22:00→06:00)
 *  with days=[5] (Friday) covers Friday 22:00 through Saturday 06:00 — the
 *  early-morning half belongs to the window that opened the previous day.
 *  startHour === endHour reads as "all day". */
export function inPeakWindow(period: PeakPeriod, timeMs: number, timezone?: string): boolean {
  const tz = timezone !== undefined && timezone.trim() !== '' ? timezone : DEFAULT_TIMEZONE
  const { hour, day } = wallClock(timeMs, tz)
  let inside: boolean
  let windowDay = day
  if (period.startHour < period.endHour) {
    inside = hour >= period.startHour && hour < period.endHour
  } else if (period.startHour > period.endHour) {
    // Overnight window: e.g. 22 → 6 means [22,24) ∪ [0,6); the morning half
    // is billed under the window that STARTED the previous day.
    inside = hour >= period.startHour || hour < period.endHour
    if (hour < period.endHour) windowDay = (day + 6) % 7
  } else {
    inside = true // start == end: the whole day
  }
  if (!inside) return false
  // Empty (or absent) days = every day; a non-empty mask restricts by the
  // window's start day (see the doc comment above).
  if (period.days !== undefined && period.days.length > 0 && !period.days.includes(windowDay)) return false
  return true
}

/**
 * Compiled holiday sets, keyed weakly by the `calendars` object they came from
 * (a Map per object, then per calendar name). Weak on purpose: `freezeTable`
 * mints a fresh object per resolve, so a price edit drops the cache together
 * with the table it belonged to, and no stale dates can outlive an edit.
 */
const calendarSets = new WeakMap<object, Map<string, ReadonlySet<string>>>()

/**
 * The holiday dates one provider observes, compiled for lookup, or undefined
 * when it names no calendar (the default: a gateway's peak windows are
 * whatever its operator configured, so it is never presumed to be on holiday).
 * @param table - the resolved table.
 * @param provider - provider id (`table.providers[provider].calendar`).
 */
export function providerHolidays(table: PriceTable, provider: string): ReadonlySet<string> | undefined {
  const name = table.providers[provider]?.calendar
  const calendars = table.calendars
  if (name === undefined || name === '') return undefined
  if (calendars === undefined) return undefined
  const dates = calendars[name]
  if (dates === undefined) return undefined
  let byName = calendarSets.get(calendars)
  if (byName === undefined) {
    byName = new Map()
    calendarSets.set(calendars, byName)
  }
  let compiled = byName.get(name)
  if (compiled === undefined) {
    // Entries may be written as inclusive ranges (the built-in calendar and any
    // hand-written layer do), so expansion happens here — the one place every
    // source funnels through — rather than trusting each writer to have
    // expanded already. Unreadable entries simply never match; the file loader
    // and the self-check CLI are what REPORT them.
    compiled = new Set(expandCalendarDates(dates).dates)
    byName.set(name, compiled)
  }
  return compiled
}

/**
 * Whether `timeMs` falls on a holiday date for this provider. The date is read
 * in the provider's OWN clock — the same `wallClock` the peak windows open in —
 * so a calendar never depends on where the host process runs.
 * @param table - the resolved table.
 * @param provider - provider id.
 * @param timeMs - the request instant.
 */
export function isHolidayAt(table: PriceTable, provider: string, timeMs: number): boolean {
  const holidays = providerHolidays(table, provider)
  if (holidays === undefined) return false
  const timezone = table.providers[provider]?.timezone
  const tz = timezone !== undefined && timezone.trim() !== '' ? timezone : DEFAULT_TIMEZONE
  return holidays.has(wallClock(timeMs, tz).date)
}

/**
 * Find the price row for one model. An EXACT reasoningEffort match wins over
 * the generic (effortless) row regardless of array order; a request without
 * an effort only ever matches the generic row. Single source for this
 * precedence — the host fold, the peak-window check and the client peak tag
 * all go through here so the three can never drift apart.
 */
export function findPriceRow(
  table: PriceTable,
  provider: string,
  model: string,
  reasoningEffort: string | undefined,
): ModelPrice | undefined {
  let generic: ModelPrice | undefined
  for (const row of table.models) {
    if (row.provider !== provider || row.model !== model) continue
    if (row.reasoningEffort === undefined) {
      generic ??= row
      continue
    }
    if (reasoningEffort !== undefined && row.reasoningEffort === reasoningEffort) return row
  }
  return generic
}

/**
 * Whether any peak window of the session's peak-configured models covers
 * `timeMs` — the single-source test behind the client's 高峰/空闲 tag
 * (host fold and browser tag can never drift apart).
 *
 * `peakModels` keys are the fold's `provider/model[/request-effort]` (see
 * `peakKey` in the host fold). The effort segment is appended whenever the
 * REQUEST carried a reasoning effort — even when that request priced the
 * effort-less GENERIC row (`findPriceRow` falls back to it) — and model ids
 * may THEMSELVES contain '/' (wpsai's vendor-prefixed ids). A key therefore
 * cannot be re-split unambiguously: the model boundary is found by matching
 * the LONGEST known model id that prefixes the key's remainder, the leftover
 * is the request effort, and the row is resolved with `findPriceRow` so an
 * effort-specific row wins over the generic row exactly as the fold priced.
 * Returns false while the table is unavailable.
 */
export function anyPeakActive(
  peakModels: readonly string[],
  table: PriceTable | undefined,
  timeMs: number,
): boolean {
  if (table === undefined) return false
  for (const key of peakModels) {
    const slash = key.indexOf('/')
    if (slash <= 0) continue
    const provider = key.slice(0, slash)
    const rest = key.slice(slash + 1)
    // Longest known model id that is the key's model segment (equal, or a
    // prefix followed by '/'); the leftover is the request's effort.
    let model: string | undefined
    let bestLen = -1
    for (const row of table.models) {
      if (row.provider !== provider) continue
      const m = row.model
      if (m.length <= bestLen) continue
      if (rest === m || rest.startsWith(`${m}/`)) {
        model = m
        bestLen = m.length
      }
    }
    if (model === undefined) continue
    const effort = rest.length > model.length ? rest.slice(model.length + 1) : undefined
    const row = findPriceRow(table, provider, model, effort)
    if (row?.periods === undefined || row.periods.length === 0) continue
    // A calendar holiday suspends every window for that local day, so the hint
    // must consult it too — otherwise the badge would say 高峰 while the fold
    // bills off-peak.
    if (isHolidayAt(table, provider, timeMs)) continue
    const timezone = table.providers[provider]?.timezone
    if (row.periods.some(p => inPeakWindow(p, timeMs, timezone))) return true
  }
  return false
}

/**
 * Order-insensitive structural equality for JSON-shaped values (what the
 * settings RPC transports). Object keys compare as sets, arrays compare
 * order-sensitively, and `undefined`-valued object keys are ignored on both
 * sides — JSON.stringify drops them and the settings transport strips them.
 *
 * The settings read-back a client sees is redaction-walked into
 * schema-declared key order (dsh-settings `redactSecrets`), so a byte-exact
 * stringify comparison of a written payload against the read-back would
 * misreport a SUCCESSFUL save as rejected whenever object key order differs —
 * e.g. a peak period that gains `days` (a new window + day selection, or the
 * official preset onto a days-less period) ends with `days` AFTER `tiers`
 * while the read-back reorders it into schema position. Deep equality is the
 * correct rejection detector: a genuinely rejected write (host validation /
 * revision conflict) leaves the stored section untouched, so content differs.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const arrA = a as readonly unknown[]
    const arrB = b as readonly unknown[]
    if (arrA.length !== arrB.length) return false
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqualJson(arrA[i], arrB[i])) return false
    }
    return true
  }
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).filter(key => objA[key] !== undefined)
  const keysB = Object.keys(objB).filter(key => objB[key] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (objB[key] === undefined || !deepEqualJson(objA[key], objB[key])) return false
  }
  return true
}

/** One priced request's cost breakdown, folded from one `assistant/message`.
 *  Drives the per-turn consumption chart/detail. All token counts are the
 *  durable usage values; cost is in PRICE_PRECISION units. */
export interface TurnCost {
  /** Conversation turn (1-based, from the event). */
  turn: number
  /** Step within the turn. */
  step: number
  /** Request wall-clock time (epoch ms) — the same value peak/off-peak uses. */
  time: number
  /** Total input this request (uncached + cache read + cache write). */
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** This request's cache hit rate: cacheRead / (uncached + cacheRead). */
  cacheHitRate: number
  /** This request's cost in PRICE_PRECISION units; 0 when unpriced. */
  cost: number
  currency: string
  period: 'peak' | 'off-peak'
  /** Whether the request's model had a registered price row. */
  priced: boolean
}

/** Settings-page model capability from the catalog route (best-effort). */
export interface ModelCapability {
  /** Adapter-disclosed context window; absent = unknown. */
  contextWindow?: number
  /** Deployment-configured single-request output cap; absent = not configured. */
  maxTokens?: number
}

/** A turn-level aggregate of its per-request rows (same TurnCost fields,
 *  summed/merged across the turn's steps). Drives the turn-grouped chart and
 *  table; the raw per-request `turns` stay available for the request view. */
export interface TurnSummary extends TurnCost {
  /** How many requests (steps) merged into this turn. */
  requests: number
}

/** Group per-request rows by turn (and currency, so a multi-currency turn
 *  never mixes values) into turn-level summaries, in log order. Merged rows
 *  sum their token buckets and cost, keep the last request's time/period, and
 *  re-derive the cache hit rate from the summed buckets; a turn is priced
 *  only when every request in it is priced. */
export function aggregateTurns(turns: readonly TurnCost[]): TurnSummary[] {
  const byTurn = new Map<string, TurnSummary>()
  for (const t of turns) {
    const key = `${t.turn}:${t.currency}`
    const prev = byTurn.get(key)
    if (prev === undefined) {
      byTurn.set(key, { ...t, requests: 1 })
      continue
    }
    prev.requests += 1
    prev.time = t.time
    prev.inputTokens += t.inputTokens
    prev.cacheReadTokens += t.cacheReadTokens
    prev.cacheWriteTokens += t.cacheWriteTokens
    prev.outputTokens += t.outputTokens
    prev.cost += t.cost
    prev.priced = prev.priced && t.priced
    prev.period = t.period
    const uncached = prev.inputTokens - prev.cacheReadTokens - prev.cacheWriteTokens
    prev.cacheHitRate = uncached + prev.cacheReadTokens > 0
      ? prev.cacheReadTokens / (uncached + prev.cacheReadTokens)
      : 0
  }
  return [...byTurn.values()]
}

/* ── Context-growth model ──────────────────────────────────────────────
 *
 *  One turn's CONTEXT GROWTH = this turn's SNAPSHOT (its last request's
 *  total input, incl. cache) MINUS the previous turn's snapshot.
 *
 *  Why snapshot deltas and not Σ(uncached input + output):
 *  - Snapshot deltas are IMMUNE to cache state. When the cache expires
 *    mid-session, the next turn's uncached input replays the entire
 *    history (a 7.5K net turn can spike to 555K), which would blow up any
 *    uncached-based growth series. The TOTAL input snapshot does not move:
 *    it counts the same context once whether it was read from cache or
 *    re-sent.
 *  - The delta also carries the turn's output implicitly (next snapshot
 *    includes this turn's assistant messages), so it measures real context
 *    growth without needing to disentangle cache hits from misses.
 *
 *  Real-log check (18 turns): snapshot deltas were 80K/110K/13K/…/2K–48K;
 *  last-10 trimmed mean ≈ 6.1K — the same order as the uncached+output
 *  net (≈ 11.2K) but stable across cache regimes.
 * ───────────────────────────────────────────────────────────────────── */

/** Per-turn context SNAPSHOTS in log order: each turn's LAST request total
 *  input (uncached + cache read + cache write). */
export function turnSnapshots(turns: readonly TurnCost[]): number[] {
  const snapshots: number[] = []
  let currentTurn: number | undefined
  let snapshot = 0
  for (const row of turns) {
    if (row.turn !== currentTurn) {
      if (currentTurn !== undefined) snapshots.push(snapshot)
      currentTurn = row.turn
    }
    snapshot = row.inputTokens // last request wins within the turn
  }
  if (currentTurn !== undefined) snapshots.push(snapshot)
  return snapshots
}

/** Per-turn context GROWTH in log order: each turn's snapshot minus the
 *  previous turn's (first turn has no growth). Cache-state immune — see the
 *  model note above. */
export function turnGrowths(turns: readonly TurnCost[]): number[] {
  const snapshots = turnSnapshots(turns)
  const growths: number[] = []
  for (let i = 1; i < snapshots.length; i += 1) {
    growths.push(snapshots[i]! - snapshots[i - 1]!)
  }
  return growths
}

/** Per-turn growth keyed by TURN NUMBER: turn N → snapshot(N) − snapshot(N−1).
 *  Index-aligning `turnGrowths` with `aggregateTurns` misaligns when a turn
 *  splits across currencies (aggregate emits one row per turn:currency while
 *  snapshots are one per turn), so consumers keying by turn must use this.
 *
 *  The FIRST turn (turn 1) keys to its whole snapshot: its predecessor is
 *  the empty context, so everything it loaded IS new occupancy — a zero here
 *  would under-report the turn that laid down the entire context. Only the
 *  true first turn qualifies: the earliest turn of a TRUNCATED frame has an
 *  unknown predecessor outside the window and stays unkeyed rather than
 *  faking its whole snapshot as growth. */
export function turnGrowthByTurn(turns: readonly TurnCost[]): Map<number, number> {
  const growth = new Map<number, number>()
  let currentTurn: number | undefined
  let snapshot = 0
  let previousSnapshot = 0
  let hasPrevious = false
  for (const row of turns) {
    if (row.turn !== currentTurn) {
      if (currentTurn !== undefined) {
        previousSnapshot = snapshot
        hasPrevious = true
      }
      currentTurn = row.turn
    }
    snapshot = row.inputTokens // last request wins within the turn
    // Recompute on every row so the LAST request of the turn decides the
    // delta (a turn's later requests, e.g. another currency's, still count).
    // Turn 1 has no prior snapshot: its growth is its whole snapshot.
    if (hasPrevious) growth.set(currentTurn!, snapshot - previousSnapshot)
    else if (currentTurn === 1) growth.set(currentTurn!, snapshot)
  }
  return growth
}

/** Bound the projection frame's turns: the most recent RECENT_TURNS_CAP
 *  conversation TURNS (a turn keeps all its tool-calling steps). */
export const RECENT_TURNS_CAP = 50
/** Context-usage ratio above which the card warns "near limit". */
export const CONTEXT_WARN_THRESHOLD = 0.85
/** Default compaction trigger ratio (compaction-basic thresholdRatio). */
export const COMPACT_TRIGGER_RATIO = 0.8

/** Trimmed mean of positive values: sort ascending, drop min & max,
 *  average the rest. < 3 values → undefined (no signal). */
function trimmedMean(values: readonly number[]): number | undefined {
  if (values.length < 3) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const trimmed = sorted.slice(1, -1)
  const growth = trimmed.reduce((acc, d) => acc + d, 0) / trimmed.length
  return growth > 0 ? growth : undefined
}

/**
 * Stable per-turn net growth over COMPLETED turns (the in-progress turn is
 * excluded: its net grows with every request until it closes, which would
 * make the series jump at turn boundaries). Two windows are combined
 * CONSERVATIVELY — the trimmed mean over the whole completed history AND
 * over the last 10 completed turn TRANSITIONS; the SMALLER wins. Early
 * sessions carry one-off setup (system prompt, schema, first loads) that
 * inflate the all-time mean; recent light turns alone would over-promise.
 * Taking the minimum keeps the estimate grounded whichever regime the session
 * is in. Non-positive growths are dropped AFTER taking the window: the "last
 * 10" must be the last 10 transitions the session actually made, not the last
 * 10 positive ones (which could reach arbitrarily far back across a
 * compaction that reset the level). Returns undefined with < 3 positive
 * growths or no growth.
 */
export function estimateCompactionGrowth(growths: readonly number[]): number | undefined {
  const all = trimmedMean(growths.filter(g => g > 0))
  const recent = trimmedMean(growths.slice(-10).filter(g => g > 0))
  if (all === undefined) return recent
  if (recent === undefined) return all
  return Math.min(all, recent)
}

/**
 * Estimate how many turns remain until the harness auto-compacts: headroom
 * (trigger line − current context snapshot) ÷ stable net growth.
 * Returns undefined when growth is unavailable or no headroom remains.
 */
export function estimateCompactionEta(
  growths: readonly number[],
  contextWindow: number,
  lastInput: number,
): number | undefined {
  const growth = estimateCompactionGrowth(growths)
  if (growth === undefined) return undefined
  const headroom = contextWindow * COMPACT_TRIGGER_RATIO - lastInput
  if (headroom <= 0) return undefined
  return Math.max(1, Math.ceil(headroom / growth))
}

/** Compaction history folded from `compaction/summary` events (log-only,
 *  appended by the harness compaction seam). `shadowedTokenCount` is the
 *  exact heuristic price of the replaced range, so the count is a real
 *  observable — no estimation on our side.
 *
 *  The summarization call itself is a real one-shot provider request (it
 *  produces no `assistant/message`), so its provider-reported usage is priced
 *  into the session totals and ALSO accumulated here (`tokens` / per-currency
 *  `cost`) to keep it attributable: mixing a giant one-shot re-read into the
 *  conversation token buckets would wreck the cache-hit-rate semantics. */
export interface CompactionStats {
  /** Number of successful compactions this session. */
  count: number
  /** Wall-clock time of the most recent compaction. */
  lastTime?: number
  /** Shadowed tokens (heuristic price) of the most recent compaction. */
  lastShadowedTokens?: number
  /** Total provider-reported tokens of all summarization calls. */
  tokens: number
  /** Summarization cost in PRICE_PRECISION units, keyed by currency. */
  cost: Record<string, number>
}

/** Per-session billing stats folded from the log. */
export interface SessionBillingStats {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** Cache hit rate: cacheRead / (uncachedInput + cacheRead), 0..1. */
  cacheHitRate: number
  /** Number of priced requests (a price row exists for the model). */
  requestCount: number
  /** Number of requests whose model had no registered price. */
  unpricedRequestCount: number
  /** Whether any priced model configures peak periods (drives the split rows). */
  hasPeakConfig: boolean
  /**
   * The most recent request's model config (provider/model + optional
   * reasoning effort). Drives the card's model line and the "locate this
   * model in settings" jump. Absent until the first request/header event —
   * the wire view must stay lossless JSON, so the key is omitted rather than
   * carried as an explicit `undefined`.
   */
  currentModel?: { provider: string; model: string; reasoningEffort?: string }
  /**
   * "provider/model[/request-effort]" keys of the models this session used
   * that configure peak windows. The effort segment is appended whenever the
   * REQUEST carried a reasoning effort — even when the request priced the
   * effort-less generic row (`findPriceRow` falls back to it). Model ids may
   * themselves contain '/' (wpsai's vendor-prefixed ids), so consumers must
   * resolve a key against the price table's known rows (`anyPeakActive`)
   * rather than re-split it. The client pairs these with the price table
   * (and a timer) to show a "currently in peak" tag without host
   * round-trips.
   */
  peakModels: string[]
  /**
   * Total cost in PRICE_PRECISION units, keyed by currency code. A session
   * can touch several providers that bill in different currencies.
   */
  cost: Record<string, number>
  /** Per-currency off-peak/peak split, in PRICE_PRECISION units. */
  byPeriod: Record<string, { offPeak: number; peak: number }>
  /** Per-request cost/token breakdown, in log order, bounded to the most
   *  recent RECENT_TURNS_CAP entries. Full history rides the turns route. */
  turns: TurnCost[]
  /** Most recent request's total input (context-usage numerator; NOT
   *  cumulative — cache hits would double-count across requests). */
  lastRequestInputTokens?: number
  /** Most recent request/context window (context-usage denominator);
   *  cleared when the model switches to an unknown-capacity route. */
  contextWindow?: number
  /** Most recent request/header config.maxTokens (effective output cap). */
  maxOutputTokens?: number
  /** Compaction history (count + last compaction facts). Drives the
   *  forecast strip on the card: the 80% trigger line, the last-compaction
   *  note, and the "N turns until compaction" estimate. */
  compactions: CompactionStats
}

/**
 * How many price units make one currency unit (100000 → 0.00001 resolution).
 * Single source for both halves: a drift here misprices everything.
 */
export const PRICE_PRECISION = 100_000

/* ── Subagent billing (on-demand route, not the projection) ──────────────
 *
 *  A subagent is its own session in the harness store/persistence (header
 *  `origin: 'subagent'` + `parentSession`), so its usage never appears in
 *  the parent's log and the parent's `billing` projection cannot see it.
 *  `/billing/api/subagents` therefore folds each descendant's own log on
 *  demand with the SAME fold + price table as the parent. These wire shapes
 *  stay here next to the cost types so both halves share one vocabulary;
 *  there is no derived average in the wire — averages are client arithmetic
 *  over `children`/totals, avoiding a second place to drift.
 */

/** Billing summary folded from one subagent session's own log. */
export interface SubagentBillingRow {
  /** The child session id (opaque; shown truncated when no label exists). */
  sessionId: string
  /**
   * Durable creation label from the child's `subagent/descriptor`
   * (`subagent/descriptor.label`). One-shot children may omit it — the card
   * falls back to a short id.
   */
  label?: string
  /** Root-relative delegation depth: direct children = 1, grandchildren = 2 … */
  depth: number
  /** Whether this child has any `origin: 'subagent'` descendant of its own. */
  hasChildren: boolean
  /** Running = live child whose log tail holds an unclosed turn. */
  activity: 'running' | 'inactive' | 'cold'
  /** Priced request count (same口径 as SessionBillingStats.requestCount). */
  requestCount: number
  /** Unpriced request count; also true-bills the card's 「未登记」 tag. */
  unpricedRequestCount: number
  /** Total input across priced AND unpriced requests: miss + hit + write. */
  inputTokens: number
  outputTokens: number
  /** Total cost per currency (PRICE_PRECISION units); compaction included. */
  cost: Record<string, number>
}

/** Aggregate over one root session's entire subagent tree. All totals are
 *  independent of the parent's own SessionBillingStats — combine on display
 *  if you want a family bill, never inside the fold. */
export interface SubagentsBillingStats {
  /** Direct children only (depth 1). */
  directCount: number
  /** Every origin-subagent descendant, all depths. */
  totalCount: number
  runningCount: number
  requestCount: number
  unpricedRequestCount: number
  inputTokens: number
  outputTokens: number
  /** Summed child costs per currency (PRICE_PRECISION units); covers ALL
   *  discovered children even when `children` is truncated. */
  cost: Record<string, number>
  /**
   * Per-currency count of children actually BILLED in that currency
   * (cost > 0), over the FULL walk — the average-cost denominator. Lives on
   * the wire because the truncated `children` list cannot supply it.
   */
  billedCount?: Record<string, number>
  /** Pre-order rows (parents before children), capped at SUBAGENT_ROWS_CAP
   *  with truncation flagged by `truncated`. Unreachable/deep-unreadable
   *  children are omitted rather than guessed. Newest-first by header
   *  createdAt (the cap keeps the MOST RECENT rows). */
  children: SubagentBillingRow[]
  /** True when `children` was cut to the cap (totals still cover ALL
   *  descendants — they come from the full walk). */
  truncated: boolean
  /** Number of children whose stats are not folded YET (bounded cold-read
   *  budget per request): polls drain the backlog incrementally. */
  pendingCount?: number
}

/** Maximum per-child rows carried by one /billing/api/subagents response. */
export const SUBAGENT_ROWS_CAP = 100

/** Convert price units to a display string with 2 decimal places. */
export function formatPrice(priceUnits: number, symbol: string): string {
  const value = priceUnits / PRICE_PRECISION
  return `${symbol}${value.toFixed(2)}`
}

/**
 * Zeroed stats (before any request). Frozen: the fold clones before
 * mutating, so every session's initial cell may share this one object.
 */
export const EMPTY_STATS: SessionBillingStats = (() => {
  const stats: SessionBillingStats = {
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    cacheHitRate: 0,
    requestCount: 0,
    unpricedRequestCount: 0,
    hasPeakConfig: false,
    peakModels: [],
    cost: {},
    byPeriod: {},
    turns: [],
    compactions: { count: 0, tokens: 0, cost: {} },
  }
  Object.freeze(stats.peakModels)
  Object.freeze(stats.cost)
  Object.freeze(stats.byPeriod)
  Object.freeze(stats.turns)
  Object.freeze(stats.compactions.cost)
  Object.freeze(stats.compactions)
  return Object.freeze(stats)
})()
