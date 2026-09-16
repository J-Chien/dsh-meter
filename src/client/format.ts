/**
 * Display formatting for billing figures. Token counts render as compact
 * human units (1.2K / 3.4M); prices render with the currency symbol at 2
 * decimal places. Price INPUTS show "元/M" decimals (1 unit = 1/100000 of
 * the currency unit) so users type `10.155` instead of `1015500`.
 */
import { PRICE_PRECISION } from '../shared.ts'

export { PRICE_PRECISION, formatPrice } from '../shared.ts'

/**
 * Axis label for a PRICE_PRECISION amount: as many decimals as the value
 * needs (up to 4), trailing zeros trimmed — so a tiny ¥0.025 cost stays
 * readable on a chart axis instead of collapsing to ¥0.00.
 */
export function formatPriceAxis(priceUnits: number, symbol: string): string {
  const value = priceUnits / PRICE_PRECISION
  const s = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  return `${symbol}${s}`
}

/**
 * Convert PRICE_PRECISION units to the decimal string an input should show:
 * at least two decimals (`10` → `10.00`), and the exact value when it has
 * more (`10.155` stays `10.155`). Integer math avoids float rounding.
 */
export function priceToInput(priceUnits: number): string {
  const whole = Math.floor(priceUnits / PRICE_PRECISION)
  const frac = String(priceUnits % PRICE_PRECISION).padStart(5, '0')
  const trimmed = frac.replace(/0+$/, '')
  const fracOut = trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, '0')
  return `${whole}.${fracOut}`
}

/**
 * Parse a user-typed decimal price into PRICE_PRECISION integer units.
 * Returns the canonical value for invalid/empty/negative input.
 * @param text - the raw input value.
 * @param fallback - the value to return when the text is not a valid non-negative decimal.
 * @returns integer PRICE_PRECISION units.
 */
export function parsePriceInput(text: string, fallback: number): number {
  const trimmed = text.trim()
  if (trimmed === '') return fallback
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.round(value * PRICE_PRECISION)
}

/**
 * Exact token count with thousands separators (`110663` → `110,663`).
 * Mirrors the official chat panel's `formatExactTokens`, whose group
 * separator is `,` in both locales it ships.
 */
export function formatExactTokens(tokens: number): string {
  const digits = String(Math.max(0, Math.round(tokens)))
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end))
  }
  return groups.join(',')
}

/** Exact token count with the official ` tok` unit: `110,663 tok`. */
export function formatExactTok(tokens: number): string {
  return `${formatExactTokens(tokens)} tok`
}

/** Compact token count with the official ` tok` unit: `111K tok`. */
export function formatCompactTok(tokens: number): string {
  return `${formatTokens(tokens)} tok`
}

/**
 * Cache-hit share for the official details row: ordinary precision is one
 * decimal (`73.1%`), and a partial hit that would round to `100.0` widens
 * its precision until the text is honest — never a fake 100%.
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param promptTokens - aggregate prompt tokens.
 * @returns percentage text, or null when there was no prompt input.
 */
export function formatCacheHitPercent(cacheReadTokens: number, promptTokens: number): string | null {
  if (promptTokens <= 0) return null
  if (cacheReadTokens >= promptTokens) return '100%'
  const ratio = (Math.max(0, cacheReadTokens) / promptTokens) * 100
  for (let places = 1; places <= 8; places += 1) {
    const text = ratio.toFixed(places)
    // `100.0`/`100.00` would claim a complete hit; widen and retry.
    if (Number(text) < 100) return `${text}%`
  }
  return '<100%'
}

/** Compact token count: 0, 999, 1.2K, 3.4M. */
export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens)
  if (tokens < 1_000_000) {
    const k = tokens / 1_000
    const s = k.toFixed(tokens < 10_000 ? 1 : 0)
    // Rounding can carry over to 1000K (e.g. 999,999) — promote to M instead.
    if (Number(s) >= 1000) return `${(tokens / 1_000_000).toFixed(2)}M`
    return `${s}K`
  }
  return `${(tokens / 1_000_000).toFixed(2)}M`
}

/** Local wall-clock time of an epoch-ms instant as HH:MM:SS (24h). */
export function formatTime(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Render a raw-token length bound as a K-token decimal for the tier editor
 * (`32000` → `32`, `200` → `0.2`). `undefined` (unbounded) renders empty.
 */
export function kTokensToInput(tokens: number | undefined): string {
  if (tokens === undefined) return ''
  return String(tokens / 1000)
}

/**
 * Parse a K-token decimal into raw tokens. An empty string means unbounded
 * (returns `undefined`). Invalid or negative input returns `null` so the
 * caller can fall back to the previous value.
 */
export function parseKTokensInput(text: string): number | undefined | null {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 1000)
}
