/**
 * Built-in default price table for the wpsai, zai, and DeepSeek provider
 * families. Values are the published official reference prices, in CNY per
 * million tokens (converted to PRICE_PRECISION units at load). These are
 * DEFAULTS — users override them in the settings page; unknown models price
 * at 0.
 *
 * zai (BigModel GLM) bills by length tier: each request's TOTAL input length
 * (uncached + cache read + cache write) and output length pick a price tier
 * for the whole request. Tiers below come from bigmodel.cn/pricing
 * (2026-08); cache write ("缓存存储") is 限时免费 (0).
 *
 * DeepSeek's own API bills by clock: the published 空闲时段 (off-peak) rate is
 * the model's base price and 高峰时段 (peak) doubles it. Peak is Beijing time,
 * Monday–Friday, 09:00–12:00 and 14:00–18:00; weekends and Chinese public
 * holidays are off-peak, and that IS modelled: a provider names a calendar in
 * `providers.<id>.calendar` (both DeepSeek routes ship with `cn`) and every
 * peak window is suspended on those local dates. A year no notice has covered
 * yet prices its holidays as peak, so the coverage is reported (settings card +
 * `check-prices.mjs`) instead of being assumed — see DEFAULT_CALENDARS below.
 * Source: api-docs.deepseek.com/zh-cn/quick_start/pricing (2026-09).
 */
import { DEEPSEEK_PEAK_WINDOWS, WEEKDAY_DAYS } from '../shared.ts'
import { PRICE_PRECISION } from './price.ts'
import type { ModelPrice, PriceTable, ProviderCurrency } from '../shared.ts'

/** Convert a CNY-per-M price string/number to PRICE_PRECISION integer units. */
export function cnyPerMillion(value: number): number {
  return Math.round(value * PRICE_PRECISION)
}

/** One DeepSeek rate triple, CNY per M tokens: [input, output, cache-hit input]. */
type DeepSeekRate = readonly [number, number, number]

/** Off-peak and peak rates for the Flash and Pro models. */
const DEEPSEEK_FLASH: DeepSeekRate = [1, 4, 0.02]
const DEEPSEEK_FLASH_PEAK: DeepSeekRate = [2, 8, 0.04]
const DEEPSEEK_PRO: DeepSeekRate = [4.5, 13.5, 0.15]
const DEEPSEEK_PRO_PEAK: DeepSeekRate = [9, 27, 0.3]

/**
 * One DeepSeek row: the off-peak rate as the model's base price, plus one
 * period per peak window carrying the peak rate. Cache WRITE is 0 — DeepSeek's
 * price list has no separate cache-write line (a write is billed as uncached
 * input).
 */
function deepSeekRow(provider: string, model: string, offPeak: DeepSeekRate, peak: DeepSeekRate): ModelPrice {
  return {
    provider,
    model,
    input: cnyPerMillion(offPeak[0]),
    output: cnyPerMillion(offPeak[1]),
    cacheInput: cnyPerMillion(offPeak[2]),
    cacheWrite: 0,
    periods: DEEPSEEK_PEAK_WINDOWS.map(([startHour, endHour]) => ({
      startHour,
      endHour,
      days: [...WEEKDAY_DAYS],
      input: cnyPerMillion(peak[0]),
      output: cnyPerMillion(peak[1]),
      cacheInput: cnyPerMillion(peak[2]),
      cacheWrite: 0,
      tiers: [],
    })),
  }
}

/**
 * Every DeepSeek row for one provider id. Both of DeepSeek's routes are the
 * same upstream service against the same price list, so both are listed:
 * `deepseek-official` (API key) and `deepseek-account` (the signed-in account
 * route).
 *
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are RETIRED names
 * DeepSeek still answers: it serves them with V4.1-Flash and bills them at
 * Flash rates, so they carry the Flash row rather than a row of their own.
 * They exist so a session that logs an old id is not reported as unpriced.
 */
function deepSeekRows(provider: string): ModelPrice[] {
  return [
    deepSeekRow(provider, 'deepseek-flash', DEEPSEEK_FLASH, DEEPSEEK_FLASH_PEAK),
    deepSeekRow(provider, 'deepseek-v4-pro', DEEPSEEK_PRO, DEEPSEEK_PRO_PEAK),
    deepSeekRow(provider, 'deepseek-v4-flash', DEEPSEEK_FLASH, DEEPSEEK_FLASH_PEAK),
    deepSeekRow(provider, 'deepseek-v4-flash-vision-exp', DEEPSEEK_FLASH, DEEPSEEK_FLASH_PEAK),
  ]
}

/** The built-in default model prices (CNY). */
export const DEFAULT_PRICES: ModelPrice[] = [
  { provider: 'wpsai', model: 'moonshot/kimi-k2.5', input: cnyPerMillion(4), output: cnyPerMillion(21), cacheInput: cnyPerMillion(0.7), cacheWrite: 0 },
  { provider: 'wpsai', model: 'deepseek/deepseek-v4-pro', input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.025), cacheWrite: 0 },
  { provider: 'wpsai', model: 'xiaomi/mimo-v2.5-pro', input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.025), cacheWrite: 0 },
  { provider: 'wpsai', model: 'xiaomi/mimo-v2.6-pro', input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.025), cacheWrite: 0 },
  { provider: 'wpsai', model: 'xiaomi/mimo-v2.6-flash', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: 0 },
  { provider: 'wpsai', model: 'ali/qwen3.7-max', input: cnyPerMillion(12), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2.4), cacheWrite: 0 },
  { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: 0 },
  { provider: 'wpsai', model: 'zhipu/glm-5', input: cnyPerMillion(4), output: cnyPerMillion(18), cacheInput: cnyPerMillion(1), cacheWrite: 0 },
  { provider: 'wpsai', model: 'zhipu/glm-5.2', input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
  { provider: 'wpsai', model: 'zhipu/glm-5.3-flashx', input: cnyPerMillion(2), output: cnyPerMillion(7), cacheInput: cnyPerMillion(0.57), cacheWrite: 0 },
  { provider: 'wpsai', model: 'doubao/Doubao-Seed-Evolving', input: cnyPerMillion(6), output: cnyPerMillion(30), cacheInput: cnyPerMillion(1.2), cacheWrite: 0 },
  { provider: 'wpsai', model: 'moonshot/kimi-k2.7-code', input: cnyPerMillion(6.5), output: cnyPerMillion(27), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
  { provider: 'wpsai', model: 'google/gemini-3.5-flash', input: cnyPerMillion(10.155), output: cnyPerMillion(60.93), cacheInput: cnyPerMillion(1.016), cacheWrite: 0 },
  { provider: 'wpsai', model: 'moonshot/kimi-k3', input: cnyPerMillion(20), output: cnyPerMillion(100), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
  { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash-0731', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: 0 },

  // zai / BigModel GLM tiered billing (CNY per M; bounds in raw tokens).
  // GLM-5.1: 输入 [0,32K) 6/24/1.3 · 输入 [32K+) 8/28/2.
  {
    provider: 'zai', model: 'glm-5.1',
    input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, input: cnyPerMillion(6), output: cnyPerMillion(24), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
      { inputMin: 32_000, input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
    ],
  },
  // GLM-4.7: 输入 [0,32K) 输出 [0,0.2K) 2/8/0.4 · 输入 [0,32K) 输出 [0.2K+) 3/14/0.6
  //          · 输入 [32K,200K) 4/16/0.8.
  {
    provider: 'zai', model: 'glm-4.7',
    input: cnyPerMillion(2), output: cnyPerMillion(8), cacheInput: cnyPerMillion(0.4), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, outputMax: 200, input: cnyPerMillion(2), output: cnyPerMillion(8), cacheInput: cnyPerMillion(0.4), cacheWrite: 0 },
      { inputMax: 32_000, outputMin: 200, input: cnyPerMillion(3), output: cnyPerMillion(14), cacheInput: cnyPerMillion(0.6), cacheWrite: 0 },
      { inputMin: 32_000, inputMax: 200_000, input: cnyPerMillion(4), output: cnyPerMillion(16), cacheInput: cnyPerMillion(0.8), cacheWrite: 0 },
    ],
  },
  // GLM-5.2: flat 8/28/2 (1M context, 缓存存储 限时免费).
  { provider: 'zai', model: 'glm-5.2', input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
  // GLM-5-Turbo: 输入 [0,32K) 5/22/1.2 · 输入 [32K+) 7/26/1.8.
  {
    provider: 'zai', model: 'glm-5-turbo',
    input: cnyPerMillion(5), output: cnyPerMillion(22), cacheInput: cnyPerMillion(1.2), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, input: cnyPerMillion(5), output: cnyPerMillion(22), cacheInput: cnyPerMillion(1.2), cacheWrite: 0 },
      { inputMin: 32_000, input: cnyPerMillion(7), output: cnyPerMillion(26), cacheInput: cnyPerMillion(1.8), cacheWrite: 0 },
    ],
  },
  // GLM-4.5-Air: 输入 [0,32K) 输出 [0,0.2K) 0.8/2/0.16 · 输入 [0,32K) 输出 [0.2K+) 0.8/6/0.16
  //              · 输入 [32K,128K) 1.2/8/0.24.
  {
    provider: 'zai', model: 'glm-4.5-air',
    input: cnyPerMillion(0.8), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.16), cacheWrite: 0,
    tiers: [
      { inputMax: 32_000, outputMax: 200, input: cnyPerMillion(0.8), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.16), cacheWrite: 0 },
      { inputMax: 32_000, outputMin: 200, input: cnyPerMillion(0.8), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.16), cacheWrite: 0 },
      { inputMin: 32_000, inputMax: 128_000, input: cnyPerMillion(1.2), output: cnyPerMillion(8), cacheInput: cnyPerMillion(0.24), cacheWrite: 0 },
    ],
  },

  // DeepSeek's own API (both routes) — see the module doc and deepSeekRows().
  ...deepSeekRows('deepseek-official'),
  ...deepSeekRows('deepseek-account'),
]

/**
 * Built-in holiday calendars. Only the 放假日 dates are listed — NOT the 调休
 * days that turn a weekend into a workday: DeepSeek's rule is 「周一至周五
 * （不含中国法定节假日）」, so a working Saturday stays 空闲. (In 2026 all six
 * 调休 days are weekends; pricing them as peak would contradict the published
 * rule, which is exactly what a generic "workday library" would do.)
 *
 * Ranges are inclusive and may include weekend days: those are already
 * off-peak, so listing them is redundant rather than wrong — the calendar is
 * kept as the notice published it, which is what makes it checkable against
 * the source line by line.
 *
 * Sources (国务院办公厅):
 *   2025 — 国办发明电〔2024〕12号  https://www.gov.cn/zhengce/content/202411/content_6986382.htm
 *   2026 — 国办发明电〔2025〕7号   https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 *
 * A year the notice has not published yet is simply absent: the fold then bills
 * that year's weekdays as peak (the pre-holiday behaviour), and the settings
 * card plus `check-prices.mjs` report which years the calendar covers, so the
 * gap is visible instead of silent. Next notice: 2027, due ~2026-11.
 */
export const DEFAULT_CALENDARS: Record<string, string[]> = {
  cn: [
    '2025-01-01', // 元旦
    '2025-01-28..2025-02-04', // 春节
    '2025-04-04..2025-04-06', // 清明
    '2025-05-01..2025-05-05', // 劳动节
    '2025-05-31..2025-06-02', // 端午
    '2025-10-01..2025-10-08', // 国庆 + 中秋
    '2026-01-01..2026-01-03', // 元旦
    '2026-02-15..2026-02-23', // 春节
    '2026-04-04..2026-04-06', // 清明
    '2026-05-01..2026-05-05', // 劳动节
    '2026-06-19..2026-06-21', // 端午
    '2026-09-25..2026-09-27', // 中秋
    '2026-10-01..2026-10-07', // 国庆
  ],
}

/** The default table: wpsai, zai, and both DeepSeek routes bill in CNY, ¥.
 *  No provider names a timezone: the fold's fallback IS `Asia/Shanghai`
 *  (shared.ts), which is the clock both DeepSeek peak windows need. */
export const DEFAULT_TABLE: PriceTable = {
  providers: {
    wpsai: { currency: 'CNY', currencySymbol: '¥' },
    zai: { currency: 'CNY', currencySymbol: '¥' },
    // DeepSeek's own peak rule excludes Chinese statutory holidays, so both of
    // its routes observe the built-in `cn` calendar. Other providers are left
    // alone on purpose: a gateway's peak windows are whatever its operator
    // configured, and silently suspending them on CN holidays would be a guess.
    'deepseek-official': { currency: 'CNY', currencySymbol: '¥', calendar: 'cn' },
    'deepseek-account': { currency: 'CNY', currencySymbol: '¥', calendar: 'cn' },
  },
  models: DEFAULT_PRICES,
  calendars: DEFAULT_CALENDARS,
}

/**
 * Fill in a provider entry's unset fields from the built-in entry for the same
 * id.
 *
 * Needed for `calendar`, and only for `calendar`: schemastery's per-provider
 * defaults are the SAME for every provider (currency CNY, symbol ¥), so a
 * profile patch that lists `providers:` — which is what any real deployment
 * does, if only to set a currency — would replace the built-in entry wholesale
 * and silently drop the shipped `calendar: cn`, billing every statutory holiday
 * at the peak rate again with nothing in the UI to show it. Currency and symbol
 * are unaffected (the schema already defaults those identically).
 *
 * @param providers - the resolved provider map from the entry config.
 * @returns a map whose entries keep their explicit fields and inherit the rest.
 */
export function withProviderDefaults(
  providers: Record<string, ProviderCurrency>,
): Record<string, ProviderCurrency> {
  const filled: Record<string, ProviderCurrency> = {}
  for (const [id, entry] of Object.entries(providers)) {
    const fallback = DEFAULT_TABLE.providers[id]
    filled[id] = fallback === undefined ? entry : { ...fallback, ...entry }
  }
  return filled
}
