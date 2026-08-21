/**
 * Built-in default price table for the provider families DSH deployments
 * commonly route. Values are official reference prices, per million tokens,
 * in each provider's BILLING currency (converted to PRICE_PRECISION units at
 * load). These are DEFAULTS — users override them in the settings page;
 * unknown models price at 0.
 *
 * Sources (2026-08):
 *  - deepseek-official: DeepSeek 官方定价页 api-docs.deepseek.com 的空闲档
 *    (OFF-PEAK;峰值 = 空闲 ×2),按 ×7 换算 CNY——与既有部署配置一致;
 *  - openai / anthropic / google / xai / mistral / upstage:官方价(USD);
 *  - moonshot / alibaba / minimax / tencent / xiaomi:官方人民币价,其中
 *    kimi-k3/k2.7-code/k2.5 与 qwen3.7-max 采用 wpsai 同源的官方 CNY 数字,
 *    其余按 USD 目录价 ×7.2 换算(dsh 默认展示汇率);
 *  - zai (BigModel GLM) 与 wpsai:见各自分组注释。
 *
 * 长上下文分段计费(tiered)按官方规则写入:整单按命中档单价计(非阶梯累进),
 * 区间为半开区间,与 price.ts 的 tierIndex 语义一致。
 * 默认不配置高峰窗口:窗口按运行机器本地时区判定,跨时区会误归属费用,
 * 由用户按自己时区在设置页配置(peak periods)。
 */
import { PRICE_PRECISION } from './price.ts'
import type { ModelPrice, PriceTable } from '../shared.ts'

/** Convert a CNY-per-M price string/number to PRICE_PRECISION integer units. */
export function cnyPerMillion(value: number): number {
  return Math.round(value * PRICE_PRECISION)
}

/** Convert a USD-per-M price string/number to PRICE_PRECISION integer units. */
export function usdPerMillion(value: number): number {
  return Math.round(value * PRICE_PRECISION)
}

/** Convert a USD-per-M catalog price to CNY-per-M at 7.2 (dsh display default). */
function cnyFromUsd(value: number): number {
  return cnyPerMillion(value * 7.2)
}

/** The built-in default model prices (per provider's billing currency). */
export const DEFAULT_PRICES: ModelPrice[] = [
  // ── wpsai(官方参考价,CNY)──────────────────────────────────────────────
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

  // ── zai / BigModel GLM tiered billing (CNY per M; bounds in raw tokens) ──
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

  // ── deepseek-official(DeepSeek 官方,CNY;空闲档 ×7 换算,峰值 = ×2)────────
  // 官方页面(2026-08):v4-flash 空闲 $0.22/$0.66(命中 $0.007)、
  // v4-pro 空闲 $0.66/$1.98(命中 $0.022);峰值翻倍。
  { provider: 'deepseek-official', model: 'deepseek-v4-flash', input: cnyPerMillion(1.5), output: cnyPerMillion(4.5), cacheInput: cnyPerMillion(0.05), cacheWrite: 0 },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', input: cnyPerMillion(4.5), output: cnyPerMillion(13.5), cacheInput: cnyPerMillion(0.15), cacheWrite: 0 },

  // ── openai(USD;gpt-5.x 长上下文 >272K 输入换档,整单按档计)──────────────
  {
    provider: 'openai', model: 'gpt-5.6-sol',
    input: usdPerMillion(5), output: usdPerMillion(30), cacheInput: usdPerMillion(0.5), cacheWrite: usdPerMillion(6.25),
    tiers: [
      { inputMax: 272_000, input: usdPerMillion(5), output: usdPerMillion(30), cacheInput: usdPerMillion(0.5), cacheWrite: usdPerMillion(6.25) },
      { inputMin: 272_000, input: usdPerMillion(10), output: usdPerMillion(45), cacheInput: usdPerMillion(1), cacheWrite: usdPerMillion(12.5) },
    ],
  },
  {
    provider: 'openai', model: 'gpt-5.6-terra',
    input: usdPerMillion(2), output: usdPerMillion(12), cacheInput: usdPerMillion(0.2), cacheWrite: usdPerMillion(2.5),
    tiers: [
      { inputMax: 272_000, input: usdPerMillion(2), output: usdPerMillion(12), cacheInput: usdPerMillion(0.2), cacheWrite: usdPerMillion(2.5) },
      { inputMin: 272_000, input: usdPerMillion(4), output: usdPerMillion(18), cacheInput: usdPerMillion(0.4), cacheWrite: usdPerMillion(5) },
    ],
  },
  {
    provider: 'openai', model: 'gpt-5.6-luna',
    input: usdPerMillion(0.2), output: usdPerMillion(1.2), cacheInput: usdPerMillion(0.02), cacheWrite: usdPerMillion(0.25),
    tiers: [
      { inputMax: 272_000, input: usdPerMillion(0.2), output: usdPerMillion(1.2), cacheInput: usdPerMillion(0.02), cacheWrite: usdPerMillion(0.25) },
      { inputMin: 272_000, input: usdPerMillion(0.4), output: usdPerMillion(1.8), cacheInput: usdPerMillion(0.04), cacheWrite: usdPerMillion(0.5) },
    ],
  },
  {
    provider: 'openai', model: 'gpt-5.5',
    input: usdPerMillion(5), output: usdPerMillion(30), cacheInput: usdPerMillion(0.5), cacheWrite: 0,
    tiers: [
      { inputMax: 272_000, input: usdPerMillion(5), output: usdPerMillion(30), cacheInput: usdPerMillion(0.5), cacheWrite: 0 },
      { inputMin: 272_000, input: usdPerMillion(10), output: usdPerMillion(45), cacheInput: usdPerMillion(1), cacheWrite: 0 },
    ],
  },
  { provider: 'openai', model: 'gpt-5.4-mini', input: usdPerMillion(0.75), output: usdPerMillion(4.5), cacheInput: usdPerMillion(0.075), cacheWrite: 0 },
  { provider: 'openai', model: 'gpt-5.4-nano', input: usdPerMillion(0.2), output: usdPerMillion(1.25), cacheInput: usdPerMillion(0.02), cacheWrite: 0 },

  // ── anthropic(USD;缓存写入按创建缓存计费)───────────────────────────────
  // claude-sonnet-5 现为早鸟价(至 2026-08-31),标准价 $3/$15。
  { provider: 'anthropic', model: 'claude-sonnet-5', input: usdPerMillion(2), output: usdPerMillion(10), cacheInput: usdPerMillion(0.2), cacheWrite: 0 },
  { provider: 'anthropic', model: 'claude-opus-5', input: usdPerMillion(5), output: usdPerMillion(25), cacheInput: usdPerMillion(0.5), cacheWrite: usdPerMillion(6.25) },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', input: usdPerMillion(3), output: usdPerMillion(15), cacheInput: usdPerMillion(0.3), cacheWrite: usdPerMillion(3.75) },
  { provider: 'anthropic', model: 'claude-haiku-4-5', input: usdPerMillion(1), output: usdPerMillion(5), cacheInput: usdPerMillion(0.1), cacheWrite: usdPerMillion(1.25) },

  // ── google(USD)─────────────────────────────────────────────────────────
  // gemini-3.7-flash 现为 2026 年底前促销价 $0.75/$3.75;2027 起 $1.5/$7.5。
  { provider: 'google', model: 'gemini-3.7-flash', input: usdPerMillion(0.75), output: usdPerMillion(3.75), cacheInput: usdPerMillion(0.75), cacheWrite: 0 },
  { provider: 'google', model: 'gemini-3.6-flash', input: usdPerMillion(1.5), output: usdPerMillion(7.5), cacheInput: usdPerMillion(0.15), cacheWrite: 0 },
  { provider: 'google', model: 'gemini-3.5-flash', input: usdPerMillion(1.5), output: usdPerMillion(9), cacheInput: usdPerMillion(0.15), cacheWrite: 0 },
  { provider: 'google', model: 'gemini-3.5-flash-lite', input: usdPerMillion(0.3), output: usdPerMillion(2.5), cacheInput: usdPerMillion(0.03), cacheWrite: 0 },
  {
    provider: 'google', model: 'gemini-3.1-pro-preview',
    input: usdPerMillion(2), output: usdPerMillion(12), cacheInput: usdPerMillion(0.2), cacheWrite: 0,
    tiers: [
      { inputMax: 200_000, input: usdPerMillion(2), output: usdPerMillion(12), cacheInput: usdPerMillion(0.2), cacheWrite: 0 },
      { inputMin: 200_000, input: usdPerMillion(4), output: usdPerMillion(18), cacheInput: usdPerMillion(0.4), cacheWrite: 0 },
    ],
  },

  // ── xai(USD;grok >200K 输入换档)────────────────────────────────────────
  {
    provider: 'xai', model: 'grok-4.6',
    input: usdPerMillion(2), output: usdPerMillion(6), cacheInput: usdPerMillion(0.5), cacheWrite: 0,
    tiers: [
      { inputMax: 200_000, input: usdPerMillion(2), output: usdPerMillion(6), cacheInput: usdPerMillion(0.5), cacheWrite: 0 },
      { inputMin: 200_000, input: usdPerMillion(4), output: usdPerMillion(12), cacheInput: usdPerMillion(1), cacheWrite: 0 },
    ],
  },
  {
    provider: 'xai', model: 'grok-4.5',
    input: usdPerMillion(2), output: usdPerMillion(6), cacheInput: usdPerMillion(0.3), cacheWrite: 0,
    tiers: [
      { inputMax: 200_000, input: usdPerMillion(2), output: usdPerMillion(6), cacheInput: usdPerMillion(0.3), cacheWrite: 0 },
      { inputMin: 200_000, input: usdPerMillion(4), output: usdPerMillion(12), cacheInput: usdPerMillion(0.6), cacheWrite: 0 },
    ],
  },
  { provider: 'xai', model: 'grok-build-0.1', input: usdPerMillion(1), output: usdPerMillion(2), cacheInput: usdPerMillion(0.2), cacheWrite: 0 },

  // ── mistral(USD)────────────────────────────────────────────────────────
  { provider: 'mistral', model: 'mistral-large-2512', input: usdPerMillion(0.5), output: usdPerMillion(1.5), cacheInput: usdPerMillion(0.05), cacheWrite: 0 },
  { provider: 'mistral', model: 'mistral-medium-3.5', input: usdPerMillion(1.5), output: usdPerMillion(7.5), cacheInput: usdPerMillion(0.15), cacheWrite: 0 },
  { provider: 'mistral', model: 'mistral-small-4.0', input: usdPerMillion(0.15), output: usdPerMillion(0.6), cacheInput: usdPerMillion(0.015), cacheWrite: 0 },

  // ── upstage(USD)────────────────────────────────────────────────────────
  { provider: 'upstage', model: 'solar-pro4', input: usdPerMillion(0.3), output: usdPerMillion(1.2), cacheInput: usdPerMillion(0.06), cacheWrite: 0 },
  { provider: 'upstage', model: 'solar-pro3', input: usdPerMillion(0.15), output: usdPerMillion(0.6), cacheInput: usdPerMillion(0.015), cacheWrite: 0 },

  // ── moonshot / Kimi(官方人民币价)───────────────────────────────────────
  { provider: 'moonshot', model: 'kimi-k3', input: cnyPerMillion(20), output: cnyPerMillion(100), cacheInput: cnyPerMillion(2), cacheWrite: 0 },
  { provider: 'moonshot', model: 'kimi-k2.7-code', input: cnyPerMillion(6.5), output: cnyPerMillion(27), cacheInput: cnyPerMillion(1.3), cacheWrite: 0 },
  { provider: 'moonshot', model: 'kimi-k2.6', input: cnyFromUsd(0.95), output: cnyFromUsd(4), cacheInput: cnyFromUsd(0.16), cacheWrite: 0 },
  // kimi-k2.5 自 2026-08-05 起弃用,保留供存量路由参考。
  { provider: 'moonshot', model: 'kimi-k2.5', input: cnyPerMillion(4), output: cnyPerMillion(21), cacheInput: cnyPerMillion(0.7), cacheWrite: 0 },

  // ── alibaba / 通义 Qwen(CNY;>256K 输入换档)─────────────────────────────
  { provider: 'alibaba', model: 'qwen3.8-max', input: cnyFromUsd(2), output: cnyFromUsd(6), cacheInput: cnyFromUsd(0.25), cacheWrite: cnyFromUsd(2.5) },
  { provider: 'alibaba', model: 'qwen3.7-max', input: cnyPerMillion(12), output: cnyPerMillion(36), cacheInput: cnyPerMillion(2.4), cacheWrite: 0 },
  {
    provider: 'alibaba', model: 'qwen3.7-plus',
    input: cnyFromUsd(0.4), output: cnyFromUsd(1.6), cacheInput: cnyFromUsd(0.04), cacheWrite: cnyFromUsd(0.5),
    tiers: [
      { inputMax: 256_000, input: cnyFromUsd(0.4), output: cnyFromUsd(1.6), cacheInput: cnyFromUsd(0.04), cacheWrite: cnyFromUsd(0.5) },
      { inputMin: 256_000, input: cnyFromUsd(1.2), output: cnyFromUsd(4.8), cacheInput: cnyFromUsd(0.12), cacheWrite: cnyFromUsd(1.5) },
    ],
  },
  {
    provider: 'alibaba', model: 'qwen3.6-plus',
    input: cnyFromUsd(0.5), output: cnyFromUsd(3), cacheInput: cnyFromUsd(0.05), cacheWrite: cnyFromUsd(0.625),
    tiers: [
      { inputMax: 256_000, input: cnyFromUsd(0.5), output: cnyFromUsd(3), cacheInput: cnyFromUsd(0.05), cacheWrite: cnyFromUsd(0.625) },
      { inputMin: 256_000, input: cnyFromUsd(2), output: cnyFromUsd(6), cacheInput: cnyFromUsd(0.2), cacheWrite: cnyFromUsd(2.5) },
    ],
  },
  { provider: 'alibaba', model: 'qwen3.5-plus', input: cnyFromUsd(0.2), output: cnyFromUsd(1.2), cacheInput: cnyFromUsd(0.02), cacheWrite: cnyFromUsd(0.25) },

  // ── minimax(CNY)────────────────────────────────────────────────────────
  { provider: 'minimax', model: 'minimax-m3', input: cnyFromUsd(0.3), output: cnyFromUsd(1.2), cacheInput: cnyFromUsd(0.06), cacheWrite: 0 },
  { provider: 'minimax', model: 'minimax-m2.7', input: cnyFromUsd(0.3), output: cnyFromUsd(1.2), cacheInput: cnyFromUsd(0.06), cacheWrite: 0 },

  // ── tencent / 混元(CNY)────────────────────────────────────────────────
  // hunyuan-a13b 官方无缓存折扣:命中价 = 未命中价。
  { provider: 'tencent', model: 'hunyuan-a13b', input: cnyFromUsd(0.5), output: cnyFromUsd(2), cacheInput: cnyFromUsd(0.5), cacheWrite: 0 },
  { provider: 'tencent', model: 'hy3', input: cnyFromUsd(0.14), output: cnyFromUsd(0.58), cacheInput: cnyFromUsd(0.035), cacheWrite: 0 },

  // ── xiaomi / MiMo(CNY)──────────────────────────────────────────────────
  { provider: 'xiaomi', model: 'mimo-v2.5', input: cnyFromUsd(0.14), output: cnyFromUsd(0.28), cacheInput: cnyFromUsd(0.0028), cacheWrite: 0 },
  { provider: 'xiaomi', model: 'mimo-v2.5-pro', input: cnyFromUsd(0.435), output: cnyFromUsd(0.87), cacheInput: cnyFromUsd(0.003625), cacheWrite: 0 },
]

/** The default table (currency per provider, per its billing currency). */
export const DEFAULT_TABLE: PriceTable = {
  providers: {
    wpsai: { currency: 'CNY', currencySymbol: '¥' },
    zai: { currency: 'CNY', currencySymbol: '¥' },
    'deepseek-official': { currency: 'CNY', currencySymbol: '¥' },
    moonshot: { currency: 'CNY', currencySymbol: '¥' },
    alibaba: { currency: 'CNY', currencySymbol: '¥' },
    minimax: { currency: 'CNY', currencySymbol: '¥' },
    tencent: { currency: 'CNY', currencySymbol: '¥' },
    xiaomi: { currency: 'CNY', currencySymbol: '¥' },
    openai: { currency: 'USD', currencySymbol: '$' },
    anthropic: { currency: 'USD', currencySymbol: '$' },
    google: { currency: 'USD', currencySymbol: '$' },
    xai: { currency: 'USD', currencySymbol: '$' },
    mistral: { currency: 'USD', currencySymbol: '$' },
    upstage: { currency: 'USD', currencySymbol: '$' },
  },
  models: DEFAULT_PRICES,
}
