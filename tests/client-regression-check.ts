/**
 * Client-half regression checks (no DOM): the settings-merge decision that
 * keeps a save from pinning the whole price table, the official-rule preset's
 * window output, the compaction-growth window slice, and the /billing/api
 * payload validation. Plus the zh/en dictionary parity the copy tables need.
 *
 * Run: node --disable-warning=ExperimentalWarning tests/client-regression-check.ts
 */
import assert from 'node:assert/strict'
import { persistedModelRows, modelRowKey } from '../src/client/settings-merge.ts'
import type { ModelPersistInput } from '../src/client/settings-merge.ts'
import { officialPeakPeriods } from '../src/client/preset.ts'
import { estimateCompactionGrowth } from '../src/shared.ts'
import { DEEPSEEK_PEAK_WINDOWS, WEEKDAY_DAYS, PRICE_PRECISION } from '../src/shared.ts'
import type { ModelPrice, PeakPeriod, PriceTier } from '../src/shared.ts'
import {
  BillingApiError, getProviderCatalog, getSubagentsStats, getTurns, refreshSessionStats,
} from '../src/client/billing-api.ts'
import { zh, en } from '../src/client/locales.ts'

const cny = (yuan: number): number => Math.round(yuan * PRICE_PRECISION)

// ── C3: settings save persists only touched rows ───────────────────────────
// The editor seeds every catalog row from the RESOLVED table (built-in +
// price file + explicit config). Writing them all back made every row explicit
// layer 1, after which the price file could no longer correct ANY model. The
// decision: edited rows only, plus the user layer's own rows verbatim.

const row = (provider: string, model: string, input = cny(1), reasoningEffort?: string): ModelPrice => ({
  provider,
  model,
  input,
  output: cny(4),
  cacheInput: cny(0.02),
  ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
})

// 1. A save with NO edits writes nothing: the C3 regression itself. The
//    built-in defaults shown by the editor are not the user's rows.
{
  const drafts: ModelPersistInput[] = [
    { key: modelRowKey(row('deepseek-official', 'deepseek-flash')), row: row('deepseek-official', 'deepseek-flash'), edited: false },
    { key: modelRowKey(row('wpsai', 'deepseek/deepseek-v4-flash')), row: row('wpsai', 'deepseek/deepseek-v4-flash'), edited: false },
  ]
  assert.deepEqual(persistedModelRows(drafts, []), [],
    'an untouched built-in/price-file row is never pinned into the user layer')
}

// 2. Only the edited row is written.
{
  const flash = row('deepseek-official', 'deepseek-flash')
  const pro = row('deepseek-official', 'deepseek-pro', cny(2))
  const drafts: ModelPersistInput[] = [
    { key: modelRowKey(flash), row: flash, edited: false },
    { key: modelRowKey(pro), row: { ...pro, input: cny(3) }, edited: true },
  ]
  const out = persistedModelRows(drafts, [])
  assert.equal(out.length, 1, 'only the edited row is persisted')
  assert.equal(out[0]?.model, 'deepseek-pro')
  assert.equal(out[0]?.input, cny(3), 'the edited value is what lands')
}

// 3. A user-layer row the draft never touched survives verbatim — otherwise a
//    second save would silently delete the first save's explicit config.
{
  const prior = row('deepseek-official', 'deepseek-flash', cny(9))
  const drafts: ModelPersistInput[] = [
    { key: modelRowKey(prior), row: row('deepseek-official', 'deepseek-flash'), edited: false },
  ]
  const out = persistedModelRows(drafts, [prior])
  assert.deepEqual(out, [prior], 'a previously explicit row is preserved, not re-derived')
}

// 4. Rows the editor cannot represent survive: off-catalog providers and
//    reasoningEffort-keyed rows (the editor only shows effort-less catalog
//    rows; keying by provider/model alone would delete them).
{
  const offCatalog = row('offline-gateway', 'mystery-model', cny(5))
  const effort = row('deepseek-official', 'deepseek-flash', cny(7), 'high')
  const edited = row('deepseek-official', 'deepseek-pro', cny(2))
  const drafts: ModelPersistInput[] = [
    { key: modelRowKey(edited), row: edited, edited: true },
    // The effort row shares provider/model with a catalog row but is a
    // different key, so the blind-spot pass must keep it.
    { key: modelRowKey(row('deepseek-official', 'deepseek-flash')), row: row('deepseek-official', 'deepseek-flash'), edited: false },
  ]
  const out = persistedModelRows(drafts, [offCatalog, effort])
  assert.deepEqual(out.map(r => `${r.provider}/${r.model}/${r.reasoningEffort ?? ''}`), [
    'deepseek-official/deepseek-pro/',
    'offline-gateway/mystery-model/',
    'deepseek-official/deepseek-flash/high',
  ], 'edited row first, then the unrepresentable user rows verbatim')
}

// 5. Clearing an edited row removes it from the user layer (falls back to the
//    file/built-in value) while other user rows stay.
{
  const cleared = row('deepseek-official', 'deepseek-flash', cny(9))
  const kept = row('zai', 'glm-4.7', cny(3))
  const drafts: ModelPersistInput[] = [
    { key: modelRowKey(cleared), row: undefined, edited: true },
  ]
  const out = persistedModelRows(drafts, [cleared, kept])
  assert.deepEqual(out, [kept], 'the cleared explicit row is dropped, the rest survive')
}

console.log('SETTINGS MERGE CHECK PASSED')

// ── C5: the official-rule preset really produces the official pair ─────────
// The regression: a model with a single weekday window 10:00–11:00 kept its
// hours while the button claimed "official rules" — neither official window
// existed. The preset now reshapes hours too.

const weekday = [1, 2, 3, 4, 5]
const base = { input: cny(1), output: cny(4), cacheInput: cny(0.02), cacheWrite: 0 }
const peakRow = (startHour: number, endHour: number, days?: number[], input = cny(2)): PeakPeriod => ({
  startHour, endHour, ...(days !== undefined ? { days } : {}), input, output: cny(8), cacheInput: cny(0.04),
})
const hours = (periods: readonly PeakPeriod[]): [number, number][] => periods.map(p => [p.startHour, p.endHour])

// 1. A non-official weekday window is replaced by the official pair; its peak
//    price carries over (the preset never invents a price).
{
  const after = officialPeakPeriods([peakRow(10, 11, [1, 3, 5])], base)
  assert.deepEqual(hours(after), DEEPSEEK_PEAK_WINDOWS.map(w => [w[0], w[1]]),
    'a single 10:00–11:00 weekday window becomes the official pair')
  assert.deepEqual(after.map(p => p.days), [weekday, weekday], 'both official windows are weekday-scoped')
  assert.deepEqual(after.map(p => p.input), [cny(2), cny(2)], 'the existing peak price carries over')
}

// 2. An already-official pair keeps its windows AND its per-window prices.
{
  const before = [peakRow(9, 12, weekday, cny(2)), peakRow(14, 18, weekday, cny(3))]
  const snapshot = JSON.stringify(before)
  const after = officialPeakPeriods(before, base)
  assert.deepEqual(hours(after), [[9, 12], [14, 18]], 'the official hours are kept, in order')
  assert.deepEqual(after.map(p => p.input), [cny(2), cny(3)], 'matched windows keep their own peak prices')
  assert.equal(JSON.stringify(before), snapshot, 'the input is not mutated')
}

// 3. Non-weekday windows are untouched; the pair is seeded beside them.
{
  const weekend = peakRow(9, 12, [0, 6], cny(3))
  const allDay = peakRow(0, 24, undefined, cny(3))
  const after = officialPeakPeriods([weekend, allDay], base)
  assert.deepEqual(after[0], weekend, 'a weekend window is left exactly as it was')
  assert.deepEqual(after[1], allDay, 'an all-day window (no days) is left exactly as it was')
  assert.deepEqual(hours(after.slice(2)), [[9, 12], [14, 18]], 'the official pair is seeded beside them')
}

// 4. No weekday window at all → seeded from off-peak prices + base tiers.
{
  const tiers: PriceTier[] = [{ input: cny(1), output: cny(4), cacheInput: cny(0.02), inputMax: 32_000 }]
  const after = officialPeakPeriods([], base, tiers)
  assert.deepEqual(hours(after), [[9, 12], [14, 18]], 'the empty model gets the official pair')
  assert.deepEqual(after[0]?.days, weekday, 'seeded windows are weekday-scoped')
  assert.equal(after[0]?.input, base.input, 'seeded windows inherit the off-peak price (no invented price)')
  assert.equal(after[0]?.tiers?.length, 1, 'seeded windows mirror the base tier structure')
}

// 5. Pure: inputs are never mutated, outputs are fresh objects.
{
  const before = [peakRow(10, 11, [1, 2, 3], cny(2))]
  const snapshot = JSON.stringify(before)
  const after = officialPeakPeriods(before, base)
  assert.equal(JSON.stringify(before), snapshot, 'preset does not mutate its input')
  assert.notEqual(after[0], before[0], 'preset returns fresh period objects')
}

console.log('OFFICIAL PRESET CHECK PASSED')

// ── C6: compaction growth takes the last 10 TRANSITIONS first ──────────────
// Slicing the positive list first let "the last 10" reach arbitrarily far back
// across a compaction (a long non-positive run is skipped). Normal sessions
// (all growths positive) keep the identical result.

// 1. All-positive: unchanged (recent window = the last 10 of the series).
{
  const growths = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  // all: 2..11 → 6.5; last 10: 3..12 → trimmed 4..11 → 7.5; min = 6.5.
  assert.equal(estimateCompactionGrowth(growths), 6.5, 'all-positive series keeps the all-time/recent minimum')
  assert.equal(estimateCompactionGrowth([10, 20, 30, 40]), 25, 'small all-positive series unchanged')
  assert.equal(estimateCompactionGrowth([10, 20]), undefined, '< 3 positive growths → no signal')
  assert.equal(estimateCompactionGrowth([]), undefined, 'empty → no signal')
}

// 2. Long non-positive run: the recent window is the last 10 transitions, so
//    the old high values fall out of it (the fix's whole point).
{
  const growths = [10000, 10000, 10000, 10000, 10000, 10000, 0, 0, 0, 20, 20, 20, 20]
  // slice(-10) = [10000,10000,10000,0,0,0,20,20,20,20] → positives
  // [10000,10000,10000,20,20,20,20] → sorted [20,20,20,20,10000,10000,10000]
  // → trimmed [20,20,20,10000,10000] → 4012. Slicing the positive list first
  // (the bug) reached back past the zero run and returned 6257.5 instead.
  assert.equal(estimateCompactionGrowth(growths), 4012, 'the last 10 transitions define the recent window')
}

console.log('COMPACTION GROWTH CHECK PASSED')

// ── C2: /billing/api payload validation ────────────────────────────────────
// A host from the peer range (>=0.1.7-rc.2 <1.0.0) that renames or drops a
// field must surface as a load/fail state, not as a render crash.

type FetchStub = (payload: unknown, opts?: { ok?: boolean; status?: number }) => string[]
const stubFetch: FetchStub = (payload, opts = {}) => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => payload,
    } as Response
  }) as typeof fetch
  return urls
}

const invalidCode = (label: string) => (error: unknown): boolean => {
  assert.ok(error instanceof BillingApiError, `${label}: throws BillingApiError (got ${String(error)})`)
  assert.equal(error.code, 'invalid', `${label}: wire code is 'invalid'`)
  return true
}

const turnRow = {
  turn: 1, step: 1, time: 1, inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0,
  outputTokens: 3, cost: 5, currency: 'CNY', period: 'off-peak', priced: true,
}

// 1. Valid payloads pass through.
{
  const urls = stubFetch({ ok: true, value: { turns: [turnRow] } })
  const turns = await getTurns('session-1')
  assert.deepEqual(turns, [turnRow], 'a valid /turns payload is returned')
  assert.equal(urls[0], '/billing/api/turns', 'the wrapper posts to the route for its method')
}

// 2. A renamed envelope field is rejected instead of setTurns(undefined).
{
  stubFetch({ ok: true, value: { rows: [turnRow] } })
  await assert.rejects(() => getTurns('session-1'), invalidCode('turns: renamed field'))
}
{
  stubFetch({ ok: true, value: { turns: [null] } })
  await assert.rejects(() => getTurns('session-1'), invalidCode('turns: null row'))
}

// 3. refresh: the card dereferences cost/byPeriod/turns on every render.
{
  const stats = { cost: {}, byPeriod: {}, turns: [], requestCount: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, cacheHitRate: 0, unpricedRequestCount: 0, hasPeakConfig: false, peakModels: [], compactions: { count: 0, tokens: 0, cost: {} } }
  stubFetch({ ok: true, value: { stats } })
  assert.deepEqual(await refreshSessionStats('s'), stats, 'a valid /refresh payload is returned')
}
{
  stubFetch({ ok: true, value: { stats: { turns: [] } } })
  await assert.rejects(() => refreshSessionStats('s'), invalidCode('refresh: missing cost'))
}
{
  // PeriodSplit indexes byPeriod per currency the moment peak config exists.
  stubFetch({ ok: true, value: { stats: { cost: {}, turns: [] } } })
  await assert.rejects(() => refreshSessionStats('s'), invalidCode('refresh: missing byPeriod'))
}

// 4. subagents: totalCount/cost/children are read as soon as the section
//    renders; a child without a per-currency cost map crashes its row.
{
  const subagents = { directCount: 0, totalCount: 0, runningCount: 0, requestCount: 0, unpricedRequestCount: 0, inputTokens: 0, outputTokens: 0, cost: {}, children: [], truncated: false }
  stubFetch({ ok: true, value: subagents })
  assert.deepEqual(await getSubagentsStats('s'), subagents, 'a valid /subagents payload is returned')
}
{
  stubFetch({ ok: true, value: { totalCount: 1, cost: {}, children: [{ sessionId: 'c1' }] } })
  await assert.rejects(() => getSubagentsStats('s'), invalidCode('subagents: child without cost'))
}
{
  stubFetch({ ok: true, value: { totalCount: 1, children: [] } })
  await assert.rejects(() => getSubagentsStats('s'), invalidCode('subagents: missing cost map'))
}

// 5. catalog: providers is mapped directly; calendar/priceFile are optional
//    (an older host omits them) but must be shaped right when they are read.
{
  const providers = [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash' }] }]
  const calendar = { names: ['cn'], dates: 3, years: [2026], missing: [], invalid: [] }
  const priceFile = { path: '/tmp/prices.yaml', present: true, rows: 2, overridden: 0, errors: [] }
  stubFetch({ ok: true, value: { providers, calendar, priceFile } })
  const catalog = await getProviderCatalog()
  assert.deepEqual(catalog.providers, providers, 'a valid /catalog payload is returned')
  assert.deepEqual(catalog.calendar, calendar, 'calendar state passes through')
  assert.deepEqual(catalog.priceFile, priceFile, 'priceFile state passes through')
}
{
  stubFetch({ ok: true, value: { providers: 'nope' } })
  await assert.rejects(() => getProviderCatalog(), invalidCode('catalog: providers not an array'))
}
{
  // A calendar whose `names` is missing would crash `calendar.names.length`.
  stubFetch({ ok: true, value: { providers: [], calendar: { dates: 0 } } })
  await assert.rejects(() => getProviderCatalog(), invalidCode('catalog: malformed calendar'))
}
{
  // A notice the card WILL show must carry the fields it renders.
  stubFetch({ ok: true, value: { providers: [], priceFile: { present: true } } })
  await assert.rejects(() => getProviderCatalog(), invalidCode('catalog: malformed priceFile'))
}
{
  // ...but a host that omits priceFile state entirely is fine.
  stubFetch({ ok: true, value: { providers: [], priceFile: { path: 'x' } } })
  const catalog = await getProviderCatalog()
  assert.equal(catalog.priceFile?.present, undefined, 'a missing `present` stays a no-notice, not a failure')
}
{
  stubFetch({ ok: true, value: { providers: [] } })
  const catalog = await getProviderCatalog()
  assert.equal(catalog.calendar, undefined, 'absent calendar state is allowed')
  assert.equal(catalog.priceFile, undefined, 'absent priceFile state is allowed')
}

// 6. HTTP + network failures keep their existing codes (the wrapper's contract).
{
  stubFetch({ ok: false, status: 403, value: undefined })
  await assert.rejects(() => getTurns('s'), (error: unknown) => {
    assert.ok(error instanceof BillingApiError)
    assert.equal(error.code, 'http', 'a non-2xx route keeps the http code')
    return true
  })
}
{
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  await assert.rejects(() => getTurns('s'), (error: unknown) => {
    assert.ok(error instanceof BillingApiError)
    assert.equal(error.code, 'network', 'a transport failure keeps the network code')
    return true
  })
}

console.log('BILLING API VALIDATION CHECK PASSED')

// ── dictionaries: zh/en parity and the C1 copy key ─────────────────────────
{
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en dictionaries stay in parity')
  assert.equal(typeof zh['refresh.failed'], 'string', 'the refresh failure copy exists in zh')
  assert.equal(typeof en['refresh.failed'], 'string', 'the refresh failure copy exists in en')
  // Removed as dead (repo-wide search): keep them from creeping back.
  assert.equal('subagents.none' in zh, false, 'dead subagents.none removed from zh')
  assert.equal('subagents.none' in en, false, 'dead subagents.none removed from en')
  assert.equal('settings.timezone.local' in zh, false, 'dead settings.timezone.local removed from zh')
  assert.equal('settings.timezone.local' in en, false, 'dead settings.timezone.local removed from en')
}

console.log('LOCALE PARITY CHECK PASSED')
