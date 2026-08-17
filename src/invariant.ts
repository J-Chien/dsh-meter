/**
 * dsh-billing invariant companion: the package folds billing from the
 * durable session log; the one relation worth asserting is that the fold
 * starts from the canonical empty state.
 */
import type { SessionBillingStats } from './shared.ts'

/** Assert the fold's empty state is the canonical zero. */
export function assertEmptyBillingStats(stats: SessionBillingStats): void {
  if (
    stats.uncachedInputTokens !== 0
    || stats.cacheReadTokens !== 0
    || stats.outputTokens !== 0
    || stats.requestCount !== 0
    || stats.unpricedRequestCount !== 0
    || stats.hasPeakConfig
    || stats.peakModels.length > 0
    || stats.currentModel !== undefined
    || Object.keys(stats.cost).length > 0
    || Object.keys(stats.byPeriod).length > 0
  ) {
    throw new Error('billing: empty stats must be all-zero')
  }
}
