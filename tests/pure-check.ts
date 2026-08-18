import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import { PRICE_PRECISION, priceTokens, effectivePrice, inPeakWindow, formatPrice } from '../src/host/price.ts'
import { cnyPerMillion, DEFAULT_TABLE } from '../src/host/default-prices.ts'
import { foldBilling, foldEvent, foldBillingBounded, boundTurns, EMPTY_STATS } from '../src/host/session-stats.ts'
import { aggregateTurns, turnSnapshots, turnGrowths, turnGrowthByTurn, estimateCompactionGrowth, estimateCompactionEta, findPriceRow } from '../src/shared.ts'
import type { PriceTable, TurnCost } from '../src/shared.ts'
import { assertEmptyBillingStats } from '../src/invariant.ts'
import { billingFence } from '../src/host/fence.ts'

// --- priceTokens ---
assert.equal(priceTokens(1_000_000, cnyPerMillion(10.155)), 1_015_500, '1M @10.155/M = 10.155')
assert.equal(priceTokens(0, 1_000), 0)
assert.equal(priceTokens(500_000, cnyPerMillion(1)), 50_000, '0.5M @1/M = 0.5')
assert.equal(formatPrice(priceTokens(1_000_000, cnyPerMillion(10.155)), '¥'), '¥10.15')
assert.equal(formatPrice(priceTokens(1_000_000, cnyPerMillion(1)), '¥'), '¥1.00')

// --- effectivePrice: default table ---
const t = DEFAULT_TABLE
assert.deepEqual(effectivePrice(t, 'wpsai', 'deepseek/deepseek-v4-flash', undefined, Date.parse('2026-08-17T12:00:00+08:00')), {
  input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: 0, period: 'off-peak', found: true,
})
assert.deepEqual(effectivePrice(t, 'wpsai', 'unknown/model', undefined, Date.now()), { input: 0, output: 0, cacheInput: 0, cacheWrite: 0, period: 'off-peak', found: false })

// --- inPeakWindow (overnight 22→06) ---
const peak = { startHour: 22, endHour: 6, input: 1, output: 1, cacheInput: 1 }
const at = (iso: string) => Date.parse(iso)
assert.equal(inPeakWindow(peak, at('2026-08-17T23:00:00+08:00')), true, '23:00 in overnight window')
assert.equal(inPeakWindow(peak, at('2026-08-17T05:00:00+08:00')), true, '05:00 in overnight window')
assert.equal(inPeakWindow(peak, at('2026-08-17T12:00:00+08:00')), false, '12:00 outside')
assert.equal(inPeakWindow(peak, at('2026-08-17T06:00:00+08:00')), false, '06:00 boundary excluded')

// --- fold over a realistic log with a peak period ---
const table: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'wpsai', model: 'deepseek/deepseek-v4-flash',
    input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02),
    periods: [{ startHour: 22, endHour: 6, input: cnyPerMillion(1.5), output: cnyPerMillion(3), cacheInput: cnyPerMillion(0.03) }],
  }],
}
const hdr = (time: number): SessionEvent<'request/header'> => ({
  type: 'request/header', seq: 0, time,
  data: { header: { config: { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash' } }, reason: 'initial' },
})
// The fold reads only `usage`; the message payload just needs to satisfy the
// AssistantMessage shape (branded MessageId cast, minimal model source).
const assistantMessage = (provider: string, model: string) => ({
  role: 'assistant' as const, content: [], id: 'm-1' as never,
  source: { kind: 'model' as const, provider, model },
})
const msg = (seq: number, time: number, input: number, output: number, cacheRead: number): SessionEvent<'assistant/message'> => ({
  type: 'assistant/message', seq, time,
  data: { turn: 1, step: 1, message: assistantMessage('wpsai', 'deepseek/deepseek-v4-flash'), usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead } },
  surfaceOp: 'append',
})

const log: SessionEvent[] = [
  hdr(at('2026-08-17T12:00:00+08:00')),
  msg(1, at('2026-08-17T12:00:05+08:00'), 100, 50, 0),
  msg(2, at('2026-08-17T23:00:00+08:00'), 80, 30, 20), // peak
]

const stats = foldBilling(log, table)
assert.equal(stats.uncachedInputTokens, 180)
assert.equal(stats.outputTokens, 80)
assert.equal(stats.cacheReadTokens, 20)
assert.equal(stats.requestCount, 2)
assert.equal(stats.unpricedRequestCount, 0)
assert.equal(stats.hasPeakConfig, true, 'peak period configured')
assert.deepEqual(stats.peakModels, ['wpsai/deepseek/deepseek-v4-flash'], 'peak-configured model collected')
assert.deepEqual(stats.currentModel, { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash' }, 'current model from last header')
assert.equal(stats.cost['CNY'], priceTokens(100, cnyPerMillion(1)) + priceTokens(50, cnyPerMillion(2))
  + priceTokens(80, cnyPerMillion(1.5)) + priceTokens(20, cnyPerMillion(0.03)) + priceTokens(30, cnyPerMillion(3)))
assert.equal(stats.byPeriod['CNY']!.offPeak, priceTokens(100, cnyPerMillion(1)) + priceTokens(50, cnyPerMillion(2)))
assert.equal(stats.byPeriod['CNY']!.peak, priceTokens(80, cnyPerMillion(1.5)) + priceTokens(20, cnyPerMillion(0.03)) + priceTokens(30, cnyPerMillion(3)))
assert.ok(Math.abs(stats.cacheHitRate - 20/200) < 1e-9)

// --- per-turn fold: turns[] + lastRequestInputTokens ---
assert.equal(stats.turns.length, 2, 'one TurnCost per assistant/message')
assert.deepEqual(stats.turns[0], {
  turn: 1, step: 1, time: at('2026-08-17T12:00:05+08:00'),
  inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50,
  cacheHitRate: 0, cost: priceTokens(100, cnyPerMillion(1)) + priceTokens(50, cnyPerMillion(2)),
  currency: 'CNY', period: 'off-peak', priced: true,
}, 'turn 1 folded: off-peak, no cache hit')
assert.deepEqual(stats.turns[1], {
  turn: 1, step: 1, time: at('2026-08-17T23:00:00+08:00'),
  inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 30,
  cacheHitRate: 0.2, cost: priceTokens(80, cnyPerMillion(1.5)) + priceTokens(20, cnyPerMillion(0.03)) + priceTokens(30, cnyPerMillion(3)),
  currency: 'CNY', period: 'peak', priced: true,
}, 'turn 2 folded: peak, cache hit counted in total input')
assert.equal(stats.lastRequestInputTokens, 100, 'lastRequestInputTokens = most recent request total input, not cumulative')

// --- request/context: set window, clear on unknown-capacity switch ---
const ctxLog: SessionEvent[] = [
  { type: 'request/context', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', contextWindow: 128_000 } },
  { type: 'request/context', seq: 1, time: at('2026-08-17T12:00:05+08:00'), data: { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash' } },
]
assert.equal(foldBilling(ctxLog, table).contextWindow, undefined, 'request/context absent window clears it')
assert.equal(foldBilling(ctxLog.slice(0, 1), table).contextWindow, 128_000, 'request/context present window sets it')

// --- request/header: maxTokens sets maxOutputTokens, absent clears; no-op includes maxTokens ---
const hdrMaxLog: SessionEvent[] = [
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', maxTokens: 8192 } }, reason: 'initial' } },
  hdr(at('2026-08-17T12:00:10+08:00')),
]
const hdrMax = foldBilling(hdrMaxLog, table)
assert.equal(hdrMax.maxOutputTokens, undefined, 'header without maxTokens clears maxOutputTokens')
const hdrMax2 = foldBilling(hdrMaxLog.slice(0, 1), table)
assert.equal(hdrMax2.maxOutputTokens, 8192, 'header maxTokens sets maxOutputTokens')

// --- no-op fast path: a header changing only maxTokens updates maxOutputTokens ---
const noOpLog: SessionEvent[] = [
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', maxTokens: 4096 } }, reason: 'initial' } },
  { type: 'request/header', seq: 1, time: at('2026-08-17T12:00:05+08:00'), data: { header: { config: { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', maxTokens: 8192 } }, reason: 'change' } },
]
assert.equal(foldBilling(noOpLog, table).maxOutputTokens, 8192, 'maxTokens-only header change still updates maxOutputTokens')

// --- bounded turns: fold keeps full, foldBillingBounded caps at 50 TURNS ---
// 60 turns × 2 requests each (a turn with tool-calling steps has >1 request).
const manyLog: SessionEvent[] = [hdr(at('2026-08-17T12:00:00+08:00'))]
for (let i = 1; i <= 60; i += 1) {
  manyLog.push({ type: 'assistant/message', seq: i * 2 - 1, time: at('2026-08-17T12:00:00+08:00') + i * 10, data: { turn: i, step: 1, message: assistantMessage('wpsai', 'deepseek/deepseek-v4-flash'), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }, surfaceOp: 'append' })
  manyLog.push({ type: 'assistant/message', seq: i * 2, time: at('2026-08-17T12:00:00+08:00') + i * 10 + 1, data: { turn: i, step: 2, message: assistantMessage('wpsai', 'deepseek/deepseek-v4-flash'), usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 0 } }, surfaceOp: 'append' })
}
assert.equal(foldBilling(manyLog, table).turns.length, 120, 'raw fold keeps full history (60 turns × 2 requests)')
const bounded = foldBillingBounded(manyLog, table)
assert.equal(bounded.turns.length, 100, 'bounded fold caps at 50 TURNS (100 requests kept)')
// The LAST 50 turns are kept (turns 11..60), each with both of its requests.
assert.equal(bounded.turns[0]!.turn, 11, 'bounded keeps the LAST 50 turns')
assert.equal(bounded.turns[1]!.turn, 11, 'a kept turn keeps both its requests')
assert.equal(bounded.turns[bounded.turns.length - 1]!.turn, 60, 'newest turn preserved')
assert.equal(bounded.turns[bounded.turns.length - 1]!.step, 2, 'newest turn keeps its last step')

// --- empty log → turns [], context fields absent ---
const emptyStats = foldBilling([], table)
assert.deepEqual(emptyStats.turns, [], 'no requests → empty turns')
assert.equal(emptyStats.lastRequestInputTokens, undefined)
assert.equal(emptyStats.contextWindow, undefined)
assert.equal(emptyStats.maxOutputTokens, undefined)

// --- invariant companion: the empty state is the canonical zero ---
assertEmptyBillingStats(emptyStats)
assertEmptyBillingStats(EMPTY_STATS)
assert.throws(() => assertEmptyBillingStats({ ...EMPTY_STATS, requestCount: 1 }), /empty stats must be all-zero/)
console.log('INVARIANT CHECK PASSED')

// --- compaction/summary fold: count + last facts ---
const compactionEvent = {
  type: 'compaction/summary', seq: 9, time: at('2026-08-17T23:30:00+08:00'),
  data: {
    compactionId: 'c-1',
    summary: [],
    shadowedRange: { start: 1, end: 4 },
    shadowedSeqs: [1, 2, 3, 4],
    shadowedTokenCount: 12_345,
    provider: 'wpsai',
    model: 'deepseek/deepseek-v4-flash',
  },
} as SessionEvent
const compacted = foldBilling([...log, compactionEvent], table)
assert.equal(compacted.compactions.count, 1, 'compaction/summary increments the count')
assert.equal(compacted.compactions.lastTime, at('2026-08-17T23:30:00+08:00'), 'last compaction time recorded')
assert.equal(compacted.compactions.lastShadowedTokens, 12_345, 'shadowed token count recorded')
assert.equal(foldBilling(log, table).compactions.count, 0, 'no compaction events → count 0')

// --- compaction/summary WITH usage: the summarization call is priced into
//     the session totals AND attributed on compactions (its tokens stay out
//     of the conversation buckets so the hit rate is not diluted) ---
const compactionWithUsage = {
  type: 'compaction/summary', seq: 9, time: at('2026-08-17T23:30:00+08:00'),
  data: {
    compactionId: 'c-1',
    summary: [],
    shadowedRange: { start: 1, end: 4 },
    shadowedSeqs: [1, 2, 3, 4],
    shadowedTokenCount: 12_345,
    provider: 'wpsai',
    model: 'deepseek/deepseek-v4-flash',
    usage: { inputTokens: 50_000, outputTokens: 1_000, cacheReadTokens: 30_000 },
  },
} as SessionEvent
const compactedUsage = foldBilling([...log, compactionWithUsage], table)
// 23:30 is inside the 22→6 peak window → the summary call bills at peak prices.
const summaryCost = priceTokens(50_000, cnyPerMillion(1.5)) + priceTokens(30_000, cnyPerMillion(0.03)) + priceTokens(1_000, cnyPerMillion(3))
assert.equal(compactedUsage.cost['CNY'], (stats.cost['CNY'] ?? 0) + summaryCost, 'summarization cost joins the session totals')
assert.equal(compactedUsage.compactions.cost['CNY'], summaryCost, 'summarization cost attributed on compactions')
assert.equal(compactedUsage.compactions.tokens, 81_000, 'summarization tokens accumulated on compactions')
assert.equal(compactedUsage.uncachedInputTokens, 180, 'summary tokens stay OUT of the conversation buckets')
assert.equal(compactedUsage.requestCount, 3, 'the summary call counts as a priced request')
assert.equal(compactedUsage.byPeriod['CNY']!.peak, (stats.byPeriod['CNY']!.peak) + summaryCost, 'summary cost lands in its peak split')
assert.equal(compactedUsage.turns.length, 2, 'no phantom turn row for the summary call')
// An UNPRICED summary model counts as unpriced but adds no cost.
const compactedUnpriced = foldBilling([...log, {
  ...compactionWithUsage,
  data: { ...compactionWithUsage.data, provider: 'wpsai', model: 'no/such-model' },
} as SessionEvent], table)
assert.equal(compactedUnpriced.unpricedRequestCount, 1, 'unpriced summary call counted')
assert.equal(compactedUnpriced.cost['CNY'], stats.cost['CNY'], 'unpriced summary adds no cost')
assert.equal(compactedUnpriced.compactions.tokens, 81_000, 'unpriced summary tokens still counted')
assert.deepEqual(compactedUnpriced.compactions.cost, {}, 'unpriced summary adds no compaction cost')

console.log('COMPACTION FOLD CHECK PASSED')

// --- turnSnapshots / turnGrowths: snapshot-delta model, cache-state immune ---
// Turn 2's cache EXPIRES between requests: uncached input replays history
// (spikes to 63K) but the TOTAL input snapshot barely moves (55K → 63K).
// The snapshot-delta model must NOT blow up on this; an uncached+output net
// model would (63K + output = 64K 'growth' for a turn that really grew 8K).
const snapRows: Parameters<typeof turnSnapshots>[0] = [
  { turn: 1, step: 1, time: 1, inputTokens: 50_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 1, step: 2, time: 2, inputTokens: 55_000, cacheReadTokens: 50_000, cacheWriteTokens: 0, outputTokens: 500, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 2, step: 1, time: 3, inputTokens: 63_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
]
assert.deepEqual(turnSnapshots(snapRows), [55_000, 63_000], 'snapshots = last request total input per turn')
assert.deepEqual(turnGrowths(snapRows), [8_000], 'cache expiry does not inflate growth')
// Multi-step turn: only the LAST request snapshot counts.
const multiSnapRows: Parameters<typeof turnSnapshots>[0] = [
  { turn: 1, step: 1, time: 1, inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 1, step: 2, time: 2, inputTokens: 9_500, cacheReadTokens: 9_000, cacheWriteTokens: 0, outputTokens: 500, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 2, step: 1, time: 3, inputTokens: 12_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
]
assert.deepEqual(turnSnapshots(multiSnapRows), [9_500, 12_000], 'last request wins within a turn')
assert.deepEqual(turnGrowths(multiSnapRows), [2_500], 'growth = next snapshot − previous snapshot')

console.log('SNAPSHOT DELTA CHECK PASSED')

// --- compaction ETA: conservative two-window trimmed mean over net growths ---
// Steady ~10K/turn net; one light (+2K) and one heavy (+20K) trimmed away.
const etaLevels = [10_000, 10_000, 2_000, 10_000, 10_000, 10_000, 20_000, 10_000]
assert.equal(estimateCompactionGrowth(etaLevels), 10_000, 'trimmed mean drops the outlier deltas')
// ETA = headroom / growth: window 128K, trigger 0.8 → 102_400; snapshot 72K → headroom 30_400 → 4 turns.
assert.equal(estimateCompactionEta(etaLevels, 128_000, 72_000), 4, 'eta = ceil(headroom / trimmed growth)')
// Two-window conservative: early setup inflates the all-time mean (seven
// +20K turns), the last 10 turns are all +2K — the SMALLER (+2K) wins.
const earlyHeavyLevels = [20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000]
assert.equal(estimateCompactionGrowth(earlyHeavyLevels), 2_000, 'conservative min of all-time vs recent windows')
assert.equal(estimateCompactionEta(earlyHeavyLevels, 256_000, 162_000), 22, 'eta uses the conservative growth (headroom 42_800 / 2K = 22)')
// No positive growth → no estimate.
const resetLevels = [0, 0, 0]
assert.equal(estimateCompactionGrowth(resetLevels), undefined, 'no positive growth → no estimate')
// No headroom (already above the trigger line) → no estimate.
assert.equal(estimateCompactionEta(etaLevels, 128_000, 110_000), undefined, 'no headroom → no estimate')

console.log('COMPACTION ETA CHECK PASSED')

// --- assistant/message WITHOUT usage → not in turns, not in totals ---
const noUsageLog: SessionEvent[] = [
  hdr(at('2026-08-17T12:00:00+08:00')),
  { type: 'assistant/message', seq: 1, time: at('2026-08-17T12:00:05+08:00'), data: { turn: 1, step: 1, message: assistantMessage('wpsai', 'deepseek/deepseek-v4-flash') }, surfaceOp: 'append' },
  msg(2, at('2026-08-17T12:00:10+08:00'), 10, 5, 0),
]
const noUsage = foldBilling(noUsageLog, table)
assert.equal(noUsage.turns.length, 1, 'message without usage is not recorded in turns')
assert.equal(noUsage.turns[0]!.inputTokens, 10, 'only the usage-bearing message forms a turn')
assert.equal(noUsage.uncachedInputTokens, 10, 'message without usage adds no tokens')
assert.equal(noUsage.requestCount, 1, 'message without usage is not counted as a priced request')
assert.equal(noUsage.lastRequestInputTokens, 10, 'lastRequestInputTokens from the usage-bearing message')

// --- unregistered model → unpricedRequestCount, no cost ---
const unregLog: SessionEvent[] = [
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'wpsai', model: 'no/such-model' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 100, 50, 0),
]
const unreg = foldBilling(unregLog, table)
assert.equal(unreg.requestCount, 0)
assert.equal(unreg.unpricedRequestCount, 1)
assert.equal(unreg.cost['CNY'], undefined)
assert.equal(unreg.hasPeakConfig, false)
assert.deepEqual(unreg.peakModels, [])
assert.equal(unreg.turns.length, 1, 'unpriced request still recorded in turns')
assert.equal(unreg.turns[0]!.priced, false, 'unpriced request marked priced=false')
assert.equal(unreg.turns[0]!.cost, 0, 'unpriced request cost is 0')
assert.equal(unreg.turns[0]!.inputTokens, 100, 'unpriced request tokens are real')
assert.deepEqual(unreg.currentModel, { provider: 'wpsai', model: 'no/such-model' }, 'unpriced model still tracked as current')

// --- no peak period → hasPeakConfig false, all off-peak ---
const noPeakTable: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{ provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02) }],
}
const noPeak = foldBilling(log, noPeakTable)
assert.equal(noPeak.hasPeakConfig, false)
assert.deepEqual(noPeak.peakModels, [])
assert.equal(noPeak.byPeriod['CNY']!.peak, 0)
assert.equal(noPeak.byPeriod['CNY']!.offPeak, priceTokens(180, cnyPerMillion(1)) + priceTokens(20, cnyPerMillion(0.02)) + priceTokens(80, cnyPerMillion(2)))

// --- multi-currency: a second provider billed in USD ---
const multiTable: PriceTable = {
  providers: {
    wpsai: { currency: 'CNY', currencySymbol: '¥' },
    google: { currency: 'USD', currencySymbol: '$' },
  },
  models: [
    { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: 0 },
    { provider: 'google', model: 'gemini-x', input: Math.round(2 * PRICE_PRECISION), output: Math.round(8 * PRICE_PRECISION), cacheInput: 0 },
  ],
}
const multiLog: SessionEvent[] = [
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'google', model: 'gemini-x' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 1000, 100, 0),
]
const multi = foldBilling(multiLog, multiTable)
assert.equal(multi.cost['USD'], priceTokens(1000, Math.round(2 * PRICE_PRECISION)) + priceTokens(100, Math.round(8 * PRICE_PRECISION)))
assert.equal(multi.cost['CNY'], undefined)

console.log('ALL PURE CHECKS PASSED')

// --- empty days = every day (schema default []) ---
const emptyDaysPeak = { startHour: 22, endHour: 6, days: [], input: 1, output: 1, cacheInput: 1 }
assert.equal(inPeakWindow(emptyDaysPeak, at('2026-08-17T23:00:00+08:00')), true, 'empty days means every day')
const restrictedDays = { startHour: 0, endHour: 24, days: [1], input: 1, output: 1, cacheInput: 1 }
// 2026-08-17 is Monday (getDay 1); 2026-08-18 is Tuesday (getDay 2).
assert.equal(inPeakWindow(restrictedDays, at('2026-08-17T12:00:00+08:00')), true, 'Monday matches days=[1]')
assert.equal(inPeakWindow(restrictedDays, at('2026-08-18T12:00:00+08:00')), false, 'Tuesday not in days=[1]')

console.log('EMPTY-DAYS CHECK PASSED')

// --- cacheWrite priced independently, not as cacheInput ---
const cwTable: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{ provider: 'wpsai', model: 'cw-model', input: cnyPerMillion(10), output: cnyPerMillion(30), cacheInput: cnyPerMillion(1), cacheWrite: cnyPerMillion(12.5) }],
}
const cwHeader: SessionEvent<'request/header'> = {
  type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'),
  data: { header: { config: { provider: 'wpsai', model: 'cw-model' } }, reason: 'initial' },
}
// Fold over the event with cacheWrite usage; expect cacheWrite priced at its own rate.
const cwEvent: SessionEvent<'assistant/message'> = {
  type: 'assistant/message', seq: 1, time: at('2026-08-17T12:00:05+08:00'),
  data: { turn: 1, step: 1, message: assistantMessage('wpsai', 'cw-model'), usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 200 } },
  surfaceOp: 'append',
}
const cwStats = foldBilling([cwHeader, cwEvent], cwTable)
assert.equal(cwStats.cacheWriteTokens, 200)
assert.equal(cwStats.cost['CNY'], priceTokens(100, cnyPerMillion(10)) + priceTokens(200, cnyPerMillion(12.5)) + priceTokens(50, cnyPerMillion(30)),
  'cacheWrite priced at its own 1.25x-input rate, not at cacheInput')

// --- cacheWrite absent → priced at 0 ---
const cwZeroTable: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{ provider: 'wpsai', model: 'cw-model', input: cnyPerMillion(10), output: cnyPerMillion(30), cacheInput: cnyPerMillion(1) }],
}
const cwZero = foldBilling([cwHeader, cwEvent], cwZeroTable)
assert.equal(cwZero.cost['CNY'], priceTokens(100, cnyPerMillion(10)) + priceTokens(200, 0) + priceTokens(50, cnyPerMillion(30)),
  'absent cacheWrite defaults to 0')

// --- tiered pricing (zai GLM-5.1): 输入 [0,32K) 6/24/1.3 · [32K+) 8/28/2 ---
const tierTable: PriceTable = {
  providers: { zai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'zai', model: 'glm-5.1',
    input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
      { inputMin: 32_000, input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
    ],
  }],
}
const tierShort = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-5.1' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 31_000, 500, 0),
], tierTable)
assert.equal(tierShort.cost['CNY'], priceTokens(31_000, cnyPerMillion(6)) + priceTokens(500, cnyPerMillion(24)),
  '31K input → tier 1 (0,32K)')
const tierLong = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-5.1' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 40_000, 500, 0),
], tierTable)
assert.equal(tierLong.cost['CNY'], priceTokens(40_000, cnyPerMillion(8)) + priceTokens(500, cnyPerMillion(28)),
  '40K input → tier 2 (32K+)')
const tierBoundary = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-5.1' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 32_000, 500, 0),
], tierTable)
assert.equal(tierBoundary.cost['CNY'], priceTokens(32_000, cnyPerMillion(8)) + priceTokens(500, cnyPerMillion(28)),
  'exactly 32K input → tier 2 (inputMax exclusive)')
// The per-turn row for a tiered request carries the SAME tiered cost (detail
// and totals stay identical even with length-based pricing).
assert.equal(tierLong.turns.length, 1, 'tiered request produces one turn row')
assert.equal(tierLong.turns[0]!.cost, priceTokens(40_000, cnyPerMillion(8)) + priceTokens(500, cnyPerMillion(28)),
  'tiered turn cost matches the matched tier prices')
assert.equal(tierLong.turns[0]!.inputTokens, 40_000, 'tiered turn input is the total input length')
assert.equal(tierLong.turns[0]!.priced, true, 'tiered model is priced')

// --- tiered pricing (zai GLM-4.7): output length splits short vs long ---
const tier47Table: PriceTable = {
  providers: { zai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'zai', model: 'glm-4.7',
    input: cnyPerMillion(2), output: cnyPerMillion(8), cacheInput: cnyPerMillion(0.4), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, outputMax: 200, input: cnyPerMillion(2), output: cnyPerMillion(8), cacheInput: cnyPerMillion(0.4), cacheWrite: 0 },
      { inputMax: 32_000, outputMin: 200, input: cnyPerMillion(3), output: cnyPerMillion(14), cacheInput: cnyPerMillion(0.6), cacheWrite: 0 },
      { inputMin: 32_000, inputMax: 200_000, input: cnyPerMillion(4), output: cnyPerMillion(16), cacheInput: cnyPerMillion(0.8), cacheWrite: 0 },
    ],
  }],
}
const tier47Short = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-4.7' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 10_000, 100, 0),
], tier47Table)
assert.equal(tier47Short.cost['CNY'], priceTokens(10_000, cnyPerMillion(2)) + priceTokens(100, cnyPerMillion(8)),
  '10K in + 100 out → tier 1')
const tier47Long = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-4.7' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 10_000, 250, 0),
], tier47Table)
assert.equal(tier47Long.cost['CNY'], priceTokens(10_000, cnyPerMillion(3)) + priceTokens(250, cnyPerMillion(14)),
  '10K in + 250 out → tier 2')
const tier47Big = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-4.7' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 50_000, 10_000, 0),
], tier47Table)
assert.equal(tier47Big.cost['CNY'], priceTokens(50_000, cnyPerMillion(4)) + priceTokens(10_000, cnyPerMillion(16)),
  '50K in → tier 3 (input 32K..200K), output ignored')
const tier47Out200 = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-4.7' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 10_000, 200, 0),
], tier47Table)
assert.equal(tier47Out200.cost['CNY'], priceTokens(10_000, cnyPerMillion(3)) + priceTokens(200, cnyPerMillion(14)),
  'exactly 200 out → tier 2 (outputMax exclusive)')

// --- cache write counted into total input for tier matching ---
const tierCw = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'zai', model: 'glm-5.1' } }, reason: 'initial' } },
  { type: 'assistant/message', seq: 1, time: at('2026-08-17T12:00:05+08:00'), data: { turn: 1, step: 1, message: assistantMessage('zai', 'glm-5.1'), usage: { inputTokens: 10_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 30_000 } }, surfaceOp: 'append' },
], tierTable)
assert.equal(tierCw.cost['CNY'], priceTokens(10_000, cnyPerMillion(8)) + priceTokens(30_000, 0) + priceTokens(100, cnyPerMillion(28)),
  'cache write 30K pushes total input to 40K → tier 2, cacheWrite at 0')

// --- default table includes the zai tiers ---
const defaultZai = DEFAULT_TABLE.models.find(m => m.provider === 'zai' && m.model === 'glm-5.1')
assert.ok(defaultZai !== undefined && defaultZai.tiers?.length === 2, 'default table has glm-5.1 with 2 tiers')
const defaultZai47 = DEFAULT_TABLE.models.find(m => m.provider === 'zai' && m.model === 'glm-4.7')
assert.ok(defaultZai47 !== undefined && defaultZai47.tiers?.length === 3, 'default table has glm-4.7 with 3 tiers')
assert.equal(DEFAULT_TABLE.providers.zai?.currency, 'CNY', 'zai provider defaults to CNY')

// --- peak period's per-tier prices align by index with the base ranges ---
const peakTierTable: PriceTable = {
  providers: { zai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'zai', model: 'glm-5.1',
    input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0,
    // Base tier RANGES (the single source of range structure).
    tiers: [
      { inputMax: 32_000, input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
      { inputMin: 32_000, input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
    ],
    periods: [{
      startHour: 9, endHour: 12,
      input: cnyPerMillion(9), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2), cacheWrite: 0,
      // Period tiers carry ONLY prices, aligned by index with the base ranges.
      tiers: [
        { input: cnyPerMillion(9), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
        { input: cnyPerMillion(12), output: cnyPerMillion(42), cacheInput: cnyPerMillion(3), cacheWrite: 0 },
      ],
    }],
  }],
}
// 10:00 peak, 40K input → base range index 1 (32K+) → PERIOD's tier[1] (12/42).
const peakTier = effectivePrice(peakTierTable, 'zai', 'glm-5.1', undefined, at('2026-08-17T10:00:00+08:00'), 40_000, 500)
assert.deepEqual(peakTier, {
  input: cnyPerMillion(12), output: cnyPerMillion(42), cacheInput: cnyPerMillion(3), cacheWrite: 0, period: 'peak', found: true,
}, 'active peak uses per-index period price for base range 1')
// 10:00 peak, 10K input → base range index 0 → PERIOD's tier[0] (9/36).
const peakTierShort = effectivePrice(peakTierTable, 'zai', 'glm-5.1', undefined, at('2026-08-17T10:00:00+08:00'), 10_000, 100)
assert.deepEqual(peakTierShort, {
  input: cnyPerMillion(9), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2), cacheWrite: 0, period: 'peak', found: true,
}, 'active peak uses per-index period price for base range 0')
// A peak period WITHOUT per-tier prices uses its flat price even for tiered models.
const peakNoTiersTable: PriceTable = {
  providers: { zai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'zai', model: 'glm-5.1',
    input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
      { inputMin: 32_000, input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
    ],
    periods: [{
      startHour: 9, endHour: 12,
      input: cnyPerMillion(9), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2), cacheWrite: 0,
      // No per-tier prices → flat price applies during peak.
    }],
  }],
}
const peakFlat = effectivePrice(peakNoTiersTable, 'zai', 'glm-5.1', undefined, at('2026-08-17T10:00:00+08:00'), 40_000, 500)
assert.deepEqual(peakFlat, {
  input: cnyPerMillion(9), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2), cacheWrite: 0, period: 'peak', found: true,
}, 'period without per-tier prices uses its flat price')

// --- default tier = unbounded (all lengths) acts as the fallback; specific
//     range tiers take precedence (new model: default price is tier 0) ---
const defaultTierTable: PriceTable = {
  providers: { zai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'zai', model: 'glm-5.1',
    input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0,
    // tier 0 = default (no range = all lengths), tier 1 = 32K+.
    tiers: [
      { input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
      { inputMin: 32_000, input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
    ],
  }],
}
// 40K input → matches tier 1 (32K+) → 8/28.
const dtLong = effectivePrice(defaultTierTable, 'zai', 'glm-5.1', undefined, at('2026-08-17T12:00:00+08:00'), 40_000, 500)
assert.deepEqual(dtLong, {
  input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0, period: 'off-peak', found: true,
}, 'specific range tier wins over the unbounded default tier')
// 10K input → no specific tier matches → falls back to the default (tier 0) prices.
const dtShort = effectivePrice(defaultTierTable, 'zai', 'glm-5.1', undefined, at('2026-08-17T12:00:00+08:00'), 10_000, 100)
assert.deepEqual(dtShort, {
  input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0, period: 'off-peak', found: true,
}, 'unbounded default tier is the fallback for unmatched lengths')
// A tier-only table with NO unbounded tier and NO flat fallback: 50K matches 32K+.
const dtOnly = effectivePrice(defaultTierTable, 'zai', 'glm-5.1', undefined, at('2026-08-17T12:00:00+08:00'), 50_000, 500)
assert.deepEqual(dtOnly, {
  input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0, period: 'off-peak', found: true,
}, '50K still matches the 32K+ tier')

console.log('ALL NEW CHECKS PASSED')

// --- foldEvent: an unchanged request/header config is a no-op (same state object) ---
const firstHeader = foldEvent({ config: undefined, stats: EMPTY_STATS }, hdr(at('2026-08-17T12:00:00+08:00')), table)
const sameHeader = foldEvent(firstHeader, hdr(at('2026-08-17T12:05:00+08:00')), table)
assert.equal(sameHeader, firstHeader, 'unchanged header config returns the same state (no no-op frame)')

console.log('HEADER NO-OP CHECK PASSED')

// --- aggregateTurns: multiple steps of one turn merge into one summary ---
const turnRows: Parameters<typeof aggregateTurns>[0] = [
  { turn: 1, step: 1, time: 1000, inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50, cacheHitRate: 0, cost: 1000, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 1, step: 2, time: 2000, inputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 20, cacheHitRate: 30 / 80, cost: 500, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 2, step: 1, time: 3000, inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, cacheHitRate: 0, cost: 300, currency: 'CNY', period: 'peak', priced: true },
  { turn: 1, step: 3, time: 4000, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, cacheHitRate: 0, cost: 0, currency: 'USD', period: 'off-peak', priced: false },
]
const agg = aggregateTurns(turnRows)
assert.equal(agg.length, 3, 'two CNY turns + one separate-currency turn')
const turn1 = agg.find(a => a.turn === 1 && a.currency === 'CNY')!
assert.equal(turn1.requests, 2, 'turn 1 merges its two CNY steps')
assert.equal(turn1.inputTokens, 150, 'input sums across steps')
assert.equal(turn1.cacheReadTokens, 30, 'cache read sums')
assert.equal(turn1.cacheWriteTokens, 10, 'cache write sums')
assert.equal(turn1.outputTokens, 70, 'output sums')
assert.equal(turn1.cost, 1500, 'cost sums')
assert.equal(turn1.time, 2000, 'keeps the last request time')
assert.equal(turn1.priced, true, 'priced when all merged steps are priced')
const turn1usd = agg.find(a => a.turn === 1 && a.currency === 'USD')!
assert.equal(turn1usd.requests, 1, 'different currency is a separate summary (no mixing)')
assert.equal(turn1usd.priced, false, 'an unpriced step keeps its turn unpriced')
const turn2 = agg.find(a => a.turn === 2)!
assert.equal(turn2.period, 'peak', 'single-request turn keeps its period')
assert.equal(Math.abs(turn1.cacheHitRate - 30 / 140) < 1e-9, true, 'hit rate re-derived from summed buckets (30/(110+30)=30/140)')
assert.equal(aggregateTurns([]).length, 0, 'empty input → empty output')

console.log('AGGREGATE TURNS CHECK PASSED')

// --- reasoningEffort precedence: an exact effort row wins over the generic
//     row regardless of array order; a request without effort never matches
//     an effort-specific row ---
const effortTable: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [
    // Generic row FIRST in the array — array order must not decide the match.
    { provider: 'wpsai', model: 'm', input: cnyPerMillion(1), output: cnyPerMillion(1), cacheInput: 0 },
    { provider: 'wpsai', model: 'm', reasoningEffort: 'high', input: cnyPerMillion(5), output: cnyPerMillion(5), cacheInput: 0 },
  ],
}
assert.equal(findPriceRow(effortTable, 'wpsai', 'm', 'high')?.input, cnyPerMillion(5), 'exact effort row wins over the generic row')
assert.equal(findPriceRow(effortTable, 'wpsai', 'm', undefined)?.input, cnyPerMillion(1), 'no-effort request matches only the generic row')
assert.equal(findPriceRow(effortTable, 'wpsai', 'm', 'low')?.input, cnyPerMillion(1), 'unknown effort falls back to the generic row')
assert.equal(effectivePrice(effortTable, 'wpsai', 'm', 'high', Date.now()).input, cnyPerMillion(5), 'effectivePrice honors effort precedence')
assert.equal(effectivePrice(effortTable, 'wpsai', 'm', undefined, Date.now()).input, cnyPerMillion(1), 'effectivePrice: no effort → generic row')

console.log('EFFORT PRECEDENCE CHECK PASSED')

// --- an effort-specific row with peak windows: the peakModels key carries
//     the effort so the client's peak tag resolves the SAME row ---
const effortPeakTable: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [
    { provider: 'wpsai', model: 'm', input: cnyPerMillion(1), output: cnyPerMillion(1), cacheInput: 0 },
    { provider: 'wpsai', model: 'm', reasoningEffort: 'high', input: cnyPerMillion(5), output: cnyPerMillion(5), cacheInput: 0,
      periods: [{ startHour: 9, endHour: 10, input: cnyPerMillion(6), output: cnyPerMillion(6), cacheInput: 0 }] },
  ],
}
const effortPeakLog: SessionEvent[] = [
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'wpsai', model: 'm', reasoningEffort: 'high' as never } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 100, 50, 0),
]
const effortPeak = foldBilling(effortPeakLog, effortPeakTable)
assert.equal(effortPeak.hasPeakConfig, true, 'effort row with periods sets hasPeakConfig')
assert.deepEqual(effortPeak.peakModels, ['wpsai/m/high'], 'peak key carries the effort segment')
// An effort-less request against the same table matches the generic row (no
// periods) and must not contribute a peak key.
const effortlessPeak = foldBilling([
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'wpsai', model: 'm' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 100, 50, 0),
], effortPeakTable)
assert.equal(effortlessPeak.hasPeakConfig, false, 'generic row has no periods')
assert.deepEqual(effortlessPeak.peakModels, [], 'no peak key for the effort-less request')

console.log('EFFORT PEAK KEY CHECK PASSED')

// --- boundTurns counts TURN NUMBERS, not turn:currency pairs: a
//     multi-currency turn occupies ONE of the 50 slots ---
const multiCurrencyTurns = (count: number): TurnCost[] => {
  const rows: TurnCost[] = []
  for (let n = 1; n <= count; n += 1) {
    rows.push({ turn: n, step: 1, time: n, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, cacheHitRate: 0, cost: 1, currency: 'CNY', period: 'off-peak', priced: true })
    rows.push({ turn: n, step: 2, time: n, inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, cacheHitRate: 0, cost: 1, currency: 'USD', period: 'off-peak', priced: true })
  }
  return rows
}
// 51 turns × 2 currencies = 102 rows: bounded to 50 TURNS = 100 rows, and
// the oldest kept turn keeps BOTH of its currency rows.
const boundMulti = boundTurns(multiCurrencyTurns(51))
assert.equal(boundMulti.length, 100, '50 turns × 2 currency rows each')
assert.equal(boundMulti[0]!.turn, 2, 'turns 2..51 kept (turn 1 dropped)')
assert.equal(boundMulti[1]!.turn, 2, 'the kept turn keeps both currency rows')
assert.equal(boundMulti[boundMulti.length - 1]!.turn, 51, 'newest turn preserved')

console.log('TURN BOUND CURRENCY CHECK PASSED')

// --- overnight window × days: days filter by the window's START day ---
// Built from a fixed DAY (Friday, getDay 5) in LOCAL time, so the assertions
// hold on any host timezone (a fixed +08:00 literal would be a different
// weekday in UTC-9 and later). The overnight rule reassigns the early-morning
// half to the day the window OPENED.
const fridayLocal = (hour: number, min = 0) => {
  const d = new Date(2026, 7, 21, hour, min, 0, 0) // 2026-08-21 is a Friday
  return d.getTime()
}
const saturdayLocal = (hour: number, min = 0) => {
  const d = new Date(2026, 7, 22, hour, min, 0, 0) // 2026-08-22 is a Saturday
  return d.getTime()
}
const fridayPeak = { startHour: 22, endHour: 6, days: [5], input: 1, output: 1, cacheInput: 1 }
assert.equal(inPeakWindow(fridayPeak, fridayLocal(23)), true, 'Fri 23:00 in Friday window')
assert.equal(inPeakWindow(fridayPeak, saturdayLocal(2)), true, 'Sat 02:00 belongs to the Friday-opened window')
assert.equal(inPeakWindow(fridayPeak, saturdayLocal(23)), false, 'Sat 23:00 opens a Saturday window — not configured')
assert.equal(inPeakWindow(fridayPeak, fridayLocal(12)), false, 'Fri noon outside the window')
// start === end reads as "all day".
const allDay = { startHour: 9, endHour: 9, input: 1, output: 1, cacheInput: 1 }
assert.equal(inPeakWindow(allDay, new Date(2026, 7, 17, 0, 0, 0, 0).getTime()), true, 'start==end: midnight inside')
assert.equal(inPeakWindow(allDay, new Date(2026, 7, 17, 12, 0, 0, 0).getTime()), true, 'start==end: noon inside')

console.log('OVERNIGHT DAYS CHECK PASSED')

// --- fence: loopback + JSON content-type + no cross-site fetch ---
const fenceReq = (headers: Record<string, string>) => ({ headers: headers as never })
assert.equal(billingFence(fenceReq({ host: 'localhost:3000', 'content-type': 'application/json' })), true, 'loopback + json passes')
assert.equal(billingFence(fenceReq({ host: '127.0.0.1:3000', 'content-type': 'application/json; charset=utf-8' })), true, '127.0.0.1 + json passes')
assert.equal(billingFence(fenceReq({ host: 'localhost:3000', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' })), true, 'same-origin passes')
assert.equal(billingFence(fenceReq({ host: 'localhost:3000', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })), false, 'cross-site fetch refused (CSRF)')
assert.equal(billingFence(fenceReq({ host: 'localhost:3000', 'content-type': 'text/plain' })), false, 'no-cors form content-type refused')
assert.equal(billingFence(fenceReq({ host: 'localhost:3000' })), false, 'missing content-type refused')
assert.equal(billingFence(fenceReq({ host: 'example.com', 'content-type': 'application/json' })), false, 'non-loopback host refused')
assert.equal(billingFence(fenceReq({ 'content-type': 'application/json' })), false, 'missing host refused')

console.log('FENCE CHECK PASSED')

// --- unpriced request keeps the provider's currency (not hardcoded CNY) ---
const unpricedCurrencyLog: SessionEvent[] = [
  { type: 'request/header', seq: 0, time: at('2026-08-17T12:00:00+08:00'), data: { header: { config: { provider: 'google', model: 'gemini-unknown' } }, reason: 'initial' } },
  msg(1, at('2026-08-17T12:00:05+08:00'), 100, 50, 0),
]
const unpricedCurrency = foldBilling(unpricedCurrencyLog, multiTable)
assert.equal(unpricedCurrency.unpricedRequestCount, 1)
assert.equal(unpricedCurrency.turns[0]!.currency, 'USD', 'unpriced request groups under the provider currency')

console.log('UNPRICED CURRENCY CHECK PASSED')

// --- turnGrowthByTurn: keyed by turn number, immune to currency splits;
//     TURN 1's growth is its whole snapshot (its predecessor is the empty
//     context — everything the first turn loaded is new occupancy), while
//     the earliest turn of a TRUNCATED frame stays unkeyed (its predecessor
//     is outside the window, so its whole snapshot is not growth) ---
const growthMap = turnGrowthByTurn([
  ...snapRows,
  // A USD row INSIDE turn 2 (multi-currency turn): snapshots stay per-turn.
  { turn: 2, step: 2, time: 4, inputTokens: 70_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, cacheHitRate: 0, cost: 0, currency: 'USD', period: 'off-peak', priced: true },
])
assert.equal(growthMap.get(1), 55_000, 'turn 1 growth = its whole snapshot')
assert.equal(growthMap.get(2), 70_000 - 55_000, 'turn 2 growth keyed by turn number, last request wins across currencies')
assert.equal(turnGrowthByTurn([]).size, 0, 'empty input → empty map')
// A truncated frame (turn 1 absent): its earliest turn has an unknown
// predecessor, so its whole snapshot must NOT be reported as growth.
const truncatedMap = turnGrowthByTurn([
  { turn: 3, step: 1, time: 5, inputTokens: 90_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
  { turn: 4, step: 1, time: 6, inputTokens: 95_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, cacheHitRate: 0, cost: 0, currency: 'CNY', period: 'off-peak', priced: true },
])
assert.equal(truncatedMap.has(3), false, 'earliest turn of a truncated frame stays unkeyed')
assert.equal(truncatedMap.get(4), 5_000, 'later turns keep snapshot deltas')

console.log('TURN GROWTH MAP CHECK PASSED')
