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
 * `inactive` (not running, and the latest turn after the child's own descriptor
 * closed NORMALLY — the same `lastTurnCompleted` fact the official roster
 * reads) → `done`;
 * `cold` (everything else: nothing closed normally yet, or it closed
 * abnormally) → `idle`, the neutral dot — completion is unproven, so it must
 * never claim `done`.
 */
export function subagentDotState(activity: SubagentBillingRow['activity']): StateDotState {
  switch (activity) {
    case 'running': return 'ongoing'
    case 'inactive': return 'done'
    case 'cold': return 'idle'
  }
}
