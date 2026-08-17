/**
 * Built-in default price table for the wpsai and zai provider families.
 * Values are the user-supplied official reference prices, in CNY per million
 * tokens (converted to PRICE_PRECISION units at load). These are DEFAULTS —
 * users override them in the settings page; unknown models price at 0.
 *
 * zai (BigModel GLM) bills by length tier: each request's TOTAL input length
 * (uncached + cache read + cache write) and output length pick a price tier
 * for the whole request. Tiers below come from bigmodel.cn/pricing
 * (2026-08); cache write ("缓存存储") is 限时免费 (0).
 */
import { PRICE_PRECISION } from './price.ts'
import type { ModelPrice, PriceTable } from '../shared.ts'

/** Convert a CNY-per-M price string/number to PRICE_PRECISION integer units. */
export function cnyPerMillion(value: number): number {
  return Math.round(value * PRICE_PRECISION)
}

/** The built-in default model prices (CNY). */
export const DEFAULT_PRICES: ModelPrice[] = [
  { provider: 'wpsai', model: 'moonshot/kimi-k2.5', input: cnyPerMillion(4), output: cnyPerMillion(21), cacheInput: cnyPerMillion(0.7), cacheWrite: 0 },
  { provider: 'wpsai', model: 'deepseek/deepseek-v4-pro', input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.025), cacheWrite: 0 },
  { provider: 'wpsai', model: 'xiaomi/mimo-v2.5-pro', input: cnyPerMillion(3), output: cnyPerMillion(6), cacheInput: cnyPerMillion(0.025), cacheWrite: 0 },
  { provider: 'wpsai', model: 'ali/qwen3.7-max', input: cnyPerMillion(12), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2.4), cacheWrite: 0 },
  { provider: 'wpsai', model: 'deepseek/deepseek-v4-flash', input: cnyPerMillion(1), output: cnyPerMillion(2), cacheInput: cnyPerMillion(0.02), cacheWrite: 0 },
  { provider: 'wpsai', model: 'zhipu/glm-5', input: cnyPerMillion(4), output: cnyPerMillion(18), cacheInput: cnyPerMillion(1), cacheWrite: 0 },
  { provider: 'wpsai', model: 'zhipu/glm-5.2', input: cnyPerMillion(8), output: cnyPerMillion(28), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
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
]

/** The default table (wpsai and zai bill in CNY, ¥). */
export const DEFAULT_TABLE: PriceTable = {
  providers: {
    wpsai: { currency: 'CNY', currencySymbol: '¥' },
    zai: { currency: 'CNY', currencySymbol: '¥' },
  },
  models: DEFAULT_PRICES,
}
