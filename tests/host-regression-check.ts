/**
 * Host regression checks for the reviewed fix list:
 *  - a non-finite price (YAML `.nan`/`.inf`) must be refused by the price-file
 *    parser, because every comparator-based gate (`min(0)`, `> RATE_CEILING`)
 *    lets NaN through;
 *  - `priceTokens` must never return NaN (it would poison every total);
 *  - a peak period's `tiers` must align BY INDEX with the row's `tiers`;
 *  - the totals-only fold (no per-request row copying) must agree with the
 *    default fold on every non-turn field, and stay correct on a large log;
 *  - the resolved-table guard must fail a non-finite row CLOSED without
 *    taking the rest of the table with it;
 *  - a subagent whose latest turn after its OWN descriptor completed NORMALLY
 *    must read as `inactive` (the official `done` dot), while one that closed
 *    abnormally or is still open stays `cold` — never a false success.
 *
 * Run: node --disable-warning=ExperimentalWarning tests/host-regression-check.ts
 */
import assert from 'node:assert/strict'
import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
// Fixtures build events by hand; the real log stamps branded seqs.
const SQ = (n: number): SessionSeq => n as SessionSeq
import type { CompactionId } from '@deepseek-ai/dsh-compaction'
import { cnyPerMillion, DEFAULT_TABLE } from '../src/host/default-prices.ts'
import { parsePriceFile } from '../src/host/price-file.ts'
import { priceTokens, dropNonFiniteRows } from '../src/host/price.ts'
import { foldBilling } from '../src/host/session-stats.ts'
import { lastTurnCompletedNormally, subagentActivity } from '../src/host/subagent-pure.ts'
import type { PriceTable, SessionBillingStats, TurnCost } from '../src/shared.ts'

const at = (iso: string): number => Date.parse(iso)

/** Drop `turns` so two folds can be compared on their non-turn fields alone. */
function withoutTurns(stats: SessionBillingStats): Omit<SessionBillingStats, 'turns'> {
  const { turns, ...rest } = stats
  void turns
  return rest
}

const assistantMessage = (provider: string, model: string) => ({
  role: 'assistant' as const, content: [], id: 'm-1' as never,
  source: { kind: 'model' as const, provider, model },
})

const hdr = (time: number, provider = 'wpsai', model = 'm'): SessionEvent<'request/header'> => ({
  type: 'request/header', seq: SQ(0), time,
  data: { header: { config: { provider, model } }, reason: 'initial' },
})

const msg = (
  seq: number,
  time: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite = 0,
  turn = 1,
  step = 1,
): SessionEvent<'assistant/message'> => ({
  type: 'assistant/message', seq: SQ(seq), time,
  data: {
    turn, step, message: assistantMessage('wpsai', 'm'), stream: [],
    usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
  },
  surfaceOp: 'append',
})

const mixedTable: PriceTable = {
  providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
  models: [{
    provider: 'wpsai', model: 'm',
    input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: cnyPerMillion(0.5),
    periods: [{
      startHour: 9, endHour: 12, days: [1, 2, 3, 4, 5],
      input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.06), cacheWrite: cnyPerMillion(1.5),
    }],
  }],
}

/* ── (a) non-finite prices are refused at parse time ─────────────────── */

{
  const nanRow = parsePriceFile(`
providers:
  p: { currency: CNY, currencySymbol: '¥' }
models:
  - provider: p
    model: good
    input: 1
    output: 2
    cacheInput: 0
  - provider: p
    model: nan-model
    input: .nan
    output: 2
    cacheInput: 0
`)
  assert.equal(nanRow.table, undefined, 'a .nan price rejects the WHOLE file (not just the row)')
  assert.equal(nanRow.errors.length, 1, 'one error per offending row')
  assert.match(nanRow.errors[0] ?? '', /p\/nan-model/, 'the message names the row')
  assert.match(nanRow.errors[0] ?? '', /non-finite/, 'and reports non-finite')
  assert.doesNotMatch(nanRow.errors[0] ?? '', /1e-5 units/, 'NOT as the raw-unit paste mistake')

  // The raw-unit guard walks periods and tiers too, so a nested NaN is caught.
  const nanPeriod = parsePriceFile(`
models:
  - provider: p
    model: m
    input: 1
    output: 2
    cacheInput: 0
    periods:
      - startHour: 9
        endHour: 12
        input: .nan
        output: 2
        cacheInput: 0
`)
  assert.equal(nanPeriod.table, undefined, 'a non-finite PERIOD rate is refused')
  assert.match(nanPeriod.errors.join(' '), /periods\[0\]\.input/, 'and the message points at the field')

  // Infinity: previously misreported as a unit mistake, now clearly non-finite.
  const infRow = parsePriceFile(`
models:
  - { provider: p, model: m, input: .inf, output: 2, cacheInput: 0 }
`)
  assert.equal(infRow.table, undefined, 'a .inf price is refused')
  assert.match(infRow.errors.join(' '), /non-finite/, 'and named as non-finite')

  // A finite price at the ceiling still passes (nothing over-eager).
  const legal = parsePriceFile(`
models:
  - { provider: p, model: m, input: 100000, output: 1, cacheInput: 0 }
`)
  assert.deepEqual(legal.errors, [], 'a legal-but-huge price is untouched')
}

console.log('NON-FINITE PRICE FILE CHECK PASSED')

/* ── (b) priceTokens never returns NaN ───────────────────────────────── */

assert.equal(priceTokens(Number.NaN, cnyPerMillion(1)), 0, 'NaN tokens → 0')
assert.equal(priceTokens(1_000, Number.NaN), 0, 'NaN rate → 0')
assert.equal(priceTokens(Number.POSITIVE_INFINITY, cnyPerMillion(1)), 0, 'Infinity tokens → 0')
assert.equal(priceTokens(Number.NEGATIVE_INFINITY, cnyPerMillion(1)), 0, '-Infinity tokens → 0')
assert.equal(priceTokens(1_000, Number.POSITIVE_INFINITY), 0, 'Infinity rate → 0')
assert.equal(Number.isFinite(priceTokens(Number.NaN, Number.NaN)), true, 'the result is never NaN')
// The finite path is unchanged.
assert.equal(priceTokens(1_000_000, cnyPerMillion(10.155)), 1_015_500, 'finite pricing still exact')

console.log('PRICE TOKENS FINITE CHECK PASSED')

/* ── (c) tier-count alignment is validated ───────────────────────────── */

{
  const orphanTiers = parsePriceFile(`
models:
  - provider: p
    model: m
    input: 1
    output: 2
    cacheInput: 0
    periods:
      - startHour: 9
        endHour: 12
        input: 1
        output: 2
        cacheInput: 0
        tiers:
          - input: 1
            output: 2
            cacheInput: 0
`)
  assert.equal(orphanTiers.table, undefined, 'a period with tiers on a tier-less row is refused')
  assert.match(orphanTiers.errors.join(' '), /declares 1 tier\(s\) but the row declares none/, 'explaining the mismatch')

  const fewerTiers = parsePriceFile(`
models:
  - provider: p
    model: m
    input: 1
    output: 2
    cacheInput: 0
    tiers:
      - { inputMax: 32000, input: 1, output: 2, cacheInput: 0 }
      - { inputMin: 32000, input: 2, output: 4, cacheInput: 0 }
    periods:
      - startHour: 9
        endHour: 12
        input: 1
        output: 2
        cacheInput: 0
        tiers:
          - { input: 1, output: 2, cacheInput: 0 }
`)
  assert.equal(fewerTiers.table, undefined, 'a period with too FEW tiers is refused')
  assert.match(fewerTiers.errors.join(' '), /declares 1 tier\(s\) but the row declares 2/, 'with both counts')

  // The aligned shape — the only one the fold can interpret — still parses.
  const aligned = parsePriceFile(`
models:
  - provider: p
    model: m
    input: 1
    output: 2
    cacheInput: 0
    tiers:
      - { inputMax: 32000, input: 1, output: 2, cacheInput: 0 }
      - { inputMin: 32000, input: 2, output: 4, cacheInput: 0 }
    periods:
      - startHour: 9
        endHour: 12
        input: 1
        output: 2
        cacheInput: 0
        tiers:
          - { input: 3, output: 6, cacheInput: 0 }
          - { input: 4, output: 8, cacheInput: 0 }
`)
  assert.deepEqual(aligned.errors, [], 'an index-aligned period parses')
  assert.equal(aligned.table?.models[0]?.periods?.[0]?.tiers?.length, 2, 'and keeps both period tiers')

  // A row with no tiers and periods with no tiers is still fine.
  const flat = parsePriceFile(`
models:
  - provider: p
    model: m
    input: 1
    output: 2
    cacheInput: 0
    periods:
      - { startHour: 9, endHour: 12, input: 1, output: 2, cacheInput: 0 }
`)
  assert.deepEqual(flat.errors, [], 'a flat tier-less row with flat periods is fine')
}

console.log('TIER ALIGNMENT CHECK PASSED')

/* ── (d) fold with turns ≡ fold without turns (non-turn fields) ──────── */

{
  const compactionEvent = {
    type: 'compaction/summary', seq: SQ(9), time: at('2026-08-17T10:30:00+08:00'),
    data: {
      compactionId: 'c-1' as CompactionId,
      summary: [],
      shadowedRange: { start: SQ(1), end: SQ(4) },
      shadowedSeqs: [SQ(1), SQ(2), SQ(3), SQ(4)],
      shadowedTokenCount: 12_345,
      provider: 'wpsai',
      model: 'm',
      usage: { inputTokens: 5_000, outputTokens: 1_000, cacheReadTokens: 2_000, cacheWriteTokens: 500 },
    },
  } as SessionEvent

  const foldLog: SessionEvent[] = [
    hdr(at('2026-08-17T12:00:00+08:00')),
    { type: 'request/context', seq: SQ(1), time: at('2026-08-17T12:00:01+08:00'), data: { provider: 'wpsai', model: 'm', contextWindow: 128_000 } },
    msg(2, at('2026-08-17T12:00:05+08:00'), 100, 50, 0), // off-peak (12:00 is the exclusive end)
    msg(3, at('2026-08-17T10:00:05+08:00'), 80, 30, 20), // peak (09–12 Mon)
    msg(4, at('2026-08-17T23:00:05+08:00'), 10, 5, 0, 0, 2, 1), // turn 2, off-peak
    compactionEvent, // priced in the peak window, no turn row
    { type: 'request/header', seq: SQ(10), time: at('2026-08-17T23:01:00+08:00'), data: { header: { config: { provider: 'wpsai', model: 'm', maxTokens: 8192 } }, reason: 'change' } },
  ]

  const withTurns = foldBilling(foldLog, mixedTable)
  const totalsOnly = foldBilling(foldLog, mixedTable, { collectTurns: false })
  assert.equal(withTurns.turns.length, 3, 'turns mode records one row per usage-bearing message (the compaction adds none)')
  assert.equal(totalsOnly.turns.length, 0, 'totals-only mode collects no turn rows')
  assert.deepEqual(withoutTurns(totalsOnly), withoutTurns(withTurns),
    'the two modes agree on EVERY non-turn field')

  // The sink mode accumulates the same rows without the per-event copy.
  const sink: TurnCost[] = []
  const sunk = foldBilling(foldLog, mixedTable, { turnsSink: sink })
  assert.deepEqual([...sink], withTurns.turns, 'the sink holds the same per-request rows in order')
  assert.deepEqual(withoutTurns(sunk), withoutTurns(withTurns), 'and the same totals')

  // Sanity on the shared totals so "identical" cannot mean "identically empty".
  assert.equal(totalsOnly.requestCount, withTurns.requestCount)
  assert.ok(totalsOnly.requestCount >= 3, 'the fold actually priced requests')
  assert.equal(totalsOnly.contextWindow, 128_000, 'context window survives the totals-only fold')
  assert.equal(totalsOnly.maxOutputTokens, 8192, 'maxOutputTokens survives the totals-only fold')
  assert.equal(totalsOnly.compactions.count, 1, 'compaction facts survive the totals-only fold')
  assert.deepEqual(totalsOnly.peakModels, ['wpsai/m'])
}

console.log('FOLD MODE EQUIVALENCE CHECK PASSED')

/* ── (e) the subagent (totals-only) fold on a large synthetic log ────── */

{
  const N = 4_000
  const peakTable: PriceTable = {
    providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
    models: [{
      provider: 'wpsai', model: 'm',
      input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: cnyPerMillion(0.5),
      // All-day, every-day: every synthetic request prices at the peak rates,
      // so the expected totals below are exact and easy to check.
      periods: [{
        startHour: 0, endHour: 24,
        input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.06), cacheWrite: cnyPerMillion(1.5),
      }],
    }],
  }
  const base = at('2026-08-17T00:00:00+08:00')
  const bigLog: SessionEvent[] = [hdr(base)]
  for (let i = 1; i <= N; i += 1) bigLog.push(msg(i, base + i * 1_000, 100, 50, 20, 5))

  const perRequest = priceTokens(100, cnyPerMillion(3))
    + priceTokens(20, cnyPerMillion(0.06))
    + priceTokens(5, cnyPerMillion(1.5))
    + priceTokens(50, cnyPerMillion(6))

  const big = foldBilling(bigLog, peakTable, { collectTurns: false })
  assert.equal(big.turns.length, 0, 'totals-only fold keeps no per-request rows')
  assert.equal(big.requestCount, N, 'every request is priced')
  assert.equal(big.unpricedRequestCount, 0)
  assert.equal(big.uncachedInputTokens, 100 * N)
  assert.equal(big.cacheReadTokens, 20 * N)
  assert.equal(big.cacheWriteTokens, 5 * N)
  assert.equal(big.outputTokens, 50 * N)
  assert.equal(big.cost['CNY'], perRequest * N, 'the cost matches the hand-computed peak price')
  assert.equal(big.byPeriod['CNY']?.peak, perRequest * N, 'all of it lands in the peak split')
  assert.equal(big.byPeriod['CNY']?.offPeak, 0)
  assert.equal(big.hasPeakConfig, true)
  assert.deepEqual(big.peakModels, ['wpsai/m'], 'the peak key is collected once, not per request')
  assert.equal(big.lastRequestInputTokens, 125, 'the last request snapshot is the last event, not a sum')

  // The default fold on the same (large) log must agree on every non-turn
  // field — this is the equivalence the subagent route relies on.
  const bigWithTurns = foldBilling(bigLog, peakTable)
  assert.equal(bigWithTurns.turns.length, N, 'the control fold did collect rows')
  assert.deepEqual(withoutTurns(big), withoutTurns(bigWithTurns), 'large-log totals agree across modes')
}

console.log('LARGE NO-TURNS FOLD CHECK PASSED')

/* ── (f) the resolved-table guard drops bad rows, keeps the rest ─────── */

{
  const guardedSource: PriceTable = {
    providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
    models: [
      { provider: 'wpsai', model: 'good', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: 0 },
      { provider: 'wpsai', model: 'bad-row', input: Number.NaN, output: cnyPerMillion(2), cacheInput: 0 },
      {
        provider: 'wpsai', model: 'bad-tier',
        input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: 0,
        tiers: [{ input: cnyPerMillion(1), output: Number.POSITIVE_INFINITY, cacheInput: 0 }],
      },
      {
        provider: 'wpsai', model: 'bad-period',
        input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: 0,
        periods: [{ startHour: 0, endHour: 24, input: Number.NaN, output: cnyPerMillion(2), cacheInput: 0 }],
      },
    ],
  }
  const { table: guarded, dropped } = dropNonFiniteRows(guardedSource)
  assert.deepEqual(dropped, ['wpsai/bad-row', 'wpsai/bad-tier', 'wpsai/bad-period'], 'every non-finite row is named')
  assert.equal(guarded.models.length, 1, 'the finite row survives')
  assert.equal(guarded.models[0]?.model, 'good')

  // The guarded table is usable: the good row still prices.
  const stats = foldBilling([hdr(at('2026-08-17T23:00:00+08:00'), 'wpsai', 'good'), msg(1, at('2026-08-17T23:00:05+08:00'), 1_000, 500, 0)], guarded)
  assert.equal(stats.requestCount, 1, 'the surviving row prices normally')
  assert.equal(stats.cost['CNY'], priceTokens(1_000, cnyPerMillion(1)) + priceTokens(500, cnyPerMillion(2)))
  assert.equal(Number.isFinite(stats.cost['CNY']), true, 'no NaN can reach the totals')

  // A fully finite table is returned by identity (no needless copy).
  const clean = dropNonFiniteRows(DEFAULT_TABLE)
  assert.equal(clean.table, DEFAULT_TABLE, 'a finite table is returned unchanged')
  assert.deepEqual(clean.dropped, [], 'and nothing is reported dropped')
}

console.log('RESOLVED TABLE FINITE GUARD CHECK PASSED')

/* ── (g) the card's subagent dot uses the OFFICIAL completion rule ───── */

// The official roster paints the solid success dot only when
//   completed = activity === 'inactive' && lastTurnCompleted === true
// where `lastTurnCompleted` is `dsh-subagent`'s `subagentTiming` fold: the
// latest turn CLOSED AFTER THE CHILD'S OWN DESCRIPTOR with
// `reason.kind === 'completed'`. Two ways to get this wrong, both locked below:
// parking every persisted child on the neutral dot (always idle), and the
// coarser "the last boundary is a turn/end" (which paints an ABORTED or FAILED
// turn green — a false success, the one thing a status dot must not claim).
{
  const desc = { type: 'subagent/descriptor', seq: SQ(0), time: 1, data: {} }
  const tStart = (t: number) => ({ type: 'turn/start', seq: SQ(0), time: t, data: { turn: 1 } })
  const tEnd = (t: number, kind: string) => ({ type: 'turn/end', seq: SQ(1), time: t, data: { turn: 1, reason: { kind } } })
  const done = tEnd(5, 'completed')
  const aborted = tEnd(5, 'aborted')

  // ── the fold itself ──
  assert.equal(lastTurnCompletedNormally([] as never), undefined, 'empty log → no claim')
  assert.equal(lastTurnCompletedNormally([desc] as never), undefined, 'descriptor alone → no claim')
  assert.equal(lastTurnCompletedNormally([desc, tStart(2)] as never), undefined, 'a turn is still open → no claim')
  assert.equal(lastTurnCompletedNormally([tEnd(2, 'completed')] as never), undefined,
    'a turn/end with no open turn changes nothing')
  assert.equal(lastTurnCompletedNormally([desc, tStart(2), done] as never), true,
    'descriptor → turn/start → turn/end(completed) → the official done')
  assert.equal(lastTurnCompletedNormally([desc, tStart(2), aborted] as never), false,
    'an ABORTED turn closed, but it did NOT complete — never green')
  assert.equal(lastTurnCompletedNormally([desc, tStart(2), tEnd(5, 'error')] as never), false,
    'a FAILED turn likewise closes without completing')
  assert.equal(lastTurnCompletedNormally([desc, tStart(2), done, tStart(9)] as never), undefined,
    'a later turn/start CLEARS the claim (the turn is open again)')
  assert.equal(lastTurnCompletedNormally([tStart(2), done, desc] as never), undefined,
    'turns from the FORK SEED (before the child own descriptor) do not count')

  // ── the three-way activity every call site uses ──
  assert.equal(subagentActivity([] as never, true), 'cold', 'live but nothing ran → neutral')
  assert.equal(subagentActivity([desc, tStart(2)] as never, true), 'running',
    'live with an open turn → the spinner')
  assert.equal(subagentActivity([desc, tStart(2), done] as never, true), 'inactive',
    'live, last turn completed → the official done')
  assert.equal(subagentActivity([desc, tStart(2), aborted] as never, true), 'cold',
    'live after an aborted turn → neutral, not done')

  assert.equal(subagentActivity([desc, tStart(2)] as never, false), 'cold',
    'persisted with an open turn is NOT running — a host-only session cannot be sampling')
  assert.equal(subagentActivity([desc, tStart(2), done] as never, false), 'inactive',
    'persisted with a normally-completed turn → the official done (this is the reported bug)')
  assert.equal(subagentActivity([desc, tStart(2), aborted] as never, false), 'cold',
    'persisted after an aborted turn → neutral')
}

console.log('SUBAGENT ACTIVITY CHECK PASSED')

console.log('ALL HOST REGRESSION CHECKS PASSED')
