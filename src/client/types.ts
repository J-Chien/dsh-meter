/**
 * Client-side declaration merge: adds the `billing` projection key to the
 * shared SessionProjectionMap table so `useProjection('billing')` typechecks
 * and the client's projection store accepts its frames. Type-only — erased
 * at build, so the bundle purity gate is unaffected.
 */
import type { SessionBillingStats } from '../shared.ts'

// rc.1 ui-slots' PropsRuntime already carries the standard session props
// (sessionId, useProjection, useSession) via SessionStandardProps merged by
// dsh-client-ui-session (the rc.7 dsh-client-runtime merge is gone).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-session billing stats computed host-side. */
    billing: SessionBillingStats
  }
}

export {}
