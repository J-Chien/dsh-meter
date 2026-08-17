/**
 * Client-side declaration merge: adds the `billing` projection key to the
 * shared SessionProjectionMap table so `useProjection('billing')` typechecks
 * and the client's projection store accepts its frames. Type-only — erased
 * at build, so the bundle purity gate is unaffected.
 */
import type { SessionBillingStats } from '../shared.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-session billing stats computed host-side. */
    billing: SessionBillingStats
  }
}

export {}
