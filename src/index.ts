/**
 * dsh-meter node half: the host billing plugin (settings namespace,
 * session projection, and /billing/api routes). Re-exports the apply used by
 * the Loader.
 */
export * from './host/index.ts'
export { foldBilling, foldEvent, EMPTY_STATS } from './host/session-stats.ts'
export type { SessionBillingStats } from './shared.ts'
export { effectivePrice, priceTokens, inPeakWindow, formatPrice, PRICE_PRECISION } from './host/price.ts'
export type { PriceTable, ModelPrice, EffectivePrice } from './host/price.ts'
export { DEFAULT_TABLE, DEFAULT_PRICES } from './host/default-prices.ts'
