/**
 * Wire shapes shared (via local copy) by the host fold and the client UI.
 * Plain JSON, deliberately independent of @deepseek-ai packages so both
 * halves can import it without crossing the bundle purity gate.
 */

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

/** Per-provider currency selection. */
export interface ProviderCurrency {
  currency: 'CNY' | 'USD'
  currencySymbol: string
}

/** The resolved price configuration (what the settings page edits). */
export interface PriceTable {
  /** Currency per provider (providers may bill in different currencies). */
  providers: Record<string, ProviderCurrency>
  models: ModelPrice[]
}

/** Whether a wall-clock instant falls inside a peak window. Shared by the
 *  host fold and the client "currently in peak" hint so window semantics
 *  stay single-source. */
export function inPeakWindow(period: PeakPeriod, timeMs: number): boolean {
  const date = new Date(timeMs)
  const day = date.getDay()
  const hour = date.getHours()
  // Empty (or absent) days = every day; a non-empty mask restricts.
  if (period.days !== undefined && period.days.length > 0 && !period.days.includes(day)) return false
  if (period.startHour < period.endHour) {
    if (hour < period.startHour || hour >= period.endHour) return false
  } else {
    // Overnight window: e.g. 22 → 6 means [22,24) ∪ [0,6).
    if (hour < period.startHour && hour >= period.endHour) return false
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

/** Turn number of the most recent request row; undefined on an empty log. */
export function currentTurnOf(turns: readonly TurnCost[]): number | undefined {
  return turns.length > 0 ? turns[turns.length - 1]!.turn : undefined
}

/** Max per-request rows the projection frame carries (bounded for size). */
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
 * over the last 10 completed turns; the SMALLER wins. Early sessions carry
 * one-off setup (system prompt, schema, first loads) that inflate the
 * all-time mean; recent light turns alone would over-promise. Taking the
 * minimum keeps the estimate grounded whichever regime the session is in.
 * Returns undefined with < 3 positive growths or no growth.
 */
export function estimateCompactionGrowth(growths: readonly number[]): number | undefined {
  const positive = growths.filter(g => g > 0)
  const all = trimmedMean(positive)
  const recent = trimmedMean(positive.slice(-10))
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
 *  observable — no estimation on our side. */
export interface CompactionStats {
  /** Number of successful compactions this session. */
  count: number
  /** Wall-clock time of the most recent compaction. */
  lastTime?: number
  /** Shadowed tokens (heuristic price) of the most recent compaction. */
  lastShadowedTokens?: number
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
   * model in settings" jump. Undefined until the first request/header event.
   */
  currentModel: { provider: string; model: string; reasoningEffort?: string } | undefined
  /**
   * "provider/model" keys of the models this session used that configure
   * peak windows. The client pairs these with the price table (and a timer)
   * to show a "currently in peak" tag in the header without host round-trips.
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
    currentModel: undefined,
    cost: {},
    byPeriod: {},
    turns: [],
    compactions: { count: 0 },
  }
  Object.freeze(stats.peakModels)
  Object.freeze(stats.cost)
  Object.freeze(stats.byPeriod)
  Object.freeze(stats.turns)
  Object.freeze(stats.compactions)
  return Object.freeze(stats)
})()
