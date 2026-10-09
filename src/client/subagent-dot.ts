/**
 * Subagent activity → the harness's OWN status-dot state.
 *
 * The official UI renders a child's status with `StateDot` from
 * `@deepseek-ai/dsh-client-ui-primitives` (see `ui-subagent`'s lineage row:
 * `ongoing` = the rotating ring, `done` = the solid success dot, `idle` = the
 * neutral dot for a tracked subject with nothing in progress). The billing
 * card must speak the same language through the SAME component — a hand-drawn
 * dot pair (green while running, hollow once finished) read as the opposite of
 * the official semantics.
 *
 * Pure on purpose: the mapping is the only thing about the dot worth testing,
 * and it stays testable in the node lane (this module imports types only).
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SubagentBillingRow } from '../shared.ts'

/**
 * `running` → `ongoing` (the spinner: live, not finished);
 * `inactive` (live child, log tail closed a turn) → `done`;
 * `cold` (persistence-only child — its live log is gone, so completion is
 * NOT knowable) → `idle`, the neutral dot: it must never claim `done`.
 */
export function subagentDotState(activity: SubagentBillingRow['activity']): StateDotState {
  switch (activity) {
    case 'running': return 'ongoing'
    case 'inactive': return 'done'
    case 'cold': return 'idle'
  }
}
