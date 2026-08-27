/**
 * Host-side declaration merge: adds the `billing` projection key to the
 * shared `SessionProjectionStateMap` table so `registry.register<'billing', …>`
 * typechecks against dsh ≥ 0.1.1-rc.1 (whose `ProjectionDefinition` keys are
 * constrained to `keyof SessionProjectionStateMap`, and whose `wire`-carrying
 * client-visible units additionally require the key in `SessionProjectionMap`).
 *
 * The client half (`src/client/types.ts`) merges the SAME key into
 * `SessionProjectionMap`; the host half must merge into the state table so the
 * fold state (`BillingFoldState`) is typed as the unit's state. Type-only —
 * erased at build, so the host bundle purity is unaffected.
 */
import type { BillingFoldState } from './session-stats.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host fold state of the per-session billing unit. */
    billing: BillingFoldState
  }
}

export {}
