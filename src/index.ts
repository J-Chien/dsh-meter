/**
 * dsh-meter node half: the host billing plugin (volatile Config price
 * table, session projection, and /billing/api routes). Re-exports the apply
 * used by the Loader.
 */
export * from './host/index.ts'
export { foldBilling, foldEvent, EMPTY_STATS } from './host/session-stats.ts'
export type { SessionBillingStats } from './shared.ts'
export { effectivePrice, priceTokens, inPeakWindow, formatPrice, PRICE_PRECISION } from './host/price.ts'
export type { PriceTable, ModelPrice, EffectivePrice } from './host/price.ts'
export { DEFAULT_TABLE, DEFAULT_PRICES, DEFAULT_CALENDARS } from './host/default-prices.ts'
export { calendarCoverage, expandCalendarDates, isIsoDate } from './calendar.ts'
// The price-file surface is exported so the self-check CLI
// (scripts/check-prices.mjs) validates a written file with the SAME loader the
// plugin runs — a checker with its own parser would happily bless a file the
// plugin then refuses.
export { parsePriceFile, loadPriceFile, mergeTables, resolvePriceFile, dshHome, RATE_CEILING } from './host/price-file.ts'
export type { PriceFileReport } from './host/price-file.ts'
