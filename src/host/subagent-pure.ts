/**
 * Pure half of subagent billing: tree discovery over a header corpus,
 * run-state judging, and the family aggregate. No store/persistence access,
 * no clock — safe to replay and unit-test in isolation. The IO half lives in
 * `subagent-stats.ts`.
 *
 * A subagent is its own session in the harness store/persistence (header
 * `origin: 'subagent'` + `parentSession`), so its usage never appears in the
 * parent's log and the parent's billing projection cannot see it.
 */
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { SubagentBillingRow, SubagentsBillingStats } from '../shared.ts'
import { SUBAGENT_ROWS_CAP } from '../shared.ts'

/** Hard discovery ceiling (deeper positions are not walked): bounds the
 *  response against pathological or cyclic corpora. Rows are separately
 *  capped at the wire limit (SUBAGENT_ROWS_CAP); totals still cover every
 *  DISCOVERED child, so a walk cut by this ceiling is its own degradation —
 *  far beyond any real delegation budget. */
export const SUBAGENT_TREE_CAP = 500

/** Whether a session header classifies as a billable subagent child: a
 *  subagent ORIGIN whose lineage points at a parent. The `parentSession`
 *  requirement keeps a hand-written origin-only header out of the fold. */
export function isDescendantHeader(
  header: Pick<SessionHeader, 'origin' | 'parentSession'>,
): boolean {
  return header.origin === 'subagent' && header.parentSession !== undefined
}

/**
 * Whether a log tail holds an unclosed conversation turn — the harness's
 * "the agent driver is sampling" state. The LAST turn boundary decides: a
 * `turn/end` closes the turn whatever its reason (completed, aborted,
 * error…); a trailing `turn/start` means still running.
 */
export function hasOpenTurn(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i]?.type
    if (type === 'turn/start') return true
    if (type === 'turn/end') return false
  }
  return false
}

/** One corpus entry: a session identity's immutable header. */
export interface SubagentCorpusRecord {
  readonly header: SessionHeader
}

/** One discovered subagent position: pre-order DFS output consumed by the
 *  route (which resolves each node's events and folds them). */
export interface SubagentNode {
  /** Session id. */
  id: string
  header: SessionHeader
  /** Root-relative BILLABLE depth: direct children = 1, a child of that
   *  child = 2 … Ordinary/fork sessions in between add NO depth — a
   *  continuable child found beneath one shows right beside its siblings.
   *  Absolute `delegationDepth` would instead count every hop and make the
   *  display indent lie about the family shape. */
  depth: number
  /** Whether this child has any origin-subagent child of its own. */
  hasChildren: boolean
}

/**
 * Collect one root's origin-subagent descendants in stable PRE-ORDER
 * (siblings by createdAt then id; parents before children) from a header
 * corpus keyed by session id. Ordinary/fork nodes between subagents stay
 * traversal branches so a continuable child beneath either is still found;
 * only origin-subagent nodes land in the result. A visited set makes fork
 * lineages re-entering a served subtree terminate.
 *
 * Discovery walks by header `parentSession` ids whether the PARENT is live
 * or cold — so the roster covers family history, not merely today's live
 * children (the same walk harness listDescendants uses over its merged
 * corpus). Positions cap at SUBAGENT_TREE_CAP.
 */
export function discoverSubagentNodes(
  corpus: ReadonlyMap<string, SubagentCorpusRecord>,
  rootId: string,
): SubagentNode[] {
  // Parent id → child ids ordered oldest-first (createdAt, then id).
  const childrenOf = new Map<string, string[]>()
  for (const [id, record] of corpus) {
    const parent = record.header.parentSession
    if (parent === undefined) continue
    const siblings = childrenOf.get(parent)
    if (siblings === undefined) childrenOf.set(parent, [id])
    else siblings.push(id)
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort((a, b) => {
      const ha = corpus.get(a)!.header.createdAt
      const hb = corpus.get(b)!.header.createdAt
      return ha - hb || a.localeCompare(b)
    })
  }

  const nodes: SubagentNode[] = []
  const visited = new Set<string>([rootId])
  // Each frame carries the billable depth the node's CHILDREN will inherit:
  // 1 directly below the root; +1 per subagent hop; ordinary/fork hops pass
  // their own inherited depth through unchanged.
  const stack = (childrenOf.get(rootId) ?? [])
    .slice()
    .reverse()
    .map(id => ({ id, childDepth: 1 }))
  while (stack.length > 0 && nodes.length < SUBAGENT_TREE_CAP) {
    const frame = stack.pop()!
    const { id } = frame
    if (visited.has(id)) continue
    visited.add(id)
    const record = corpus.get(id)
    if (record === undefined) continue
    const childIds = childrenOf.get(id) ?? []
    if (isDescendantHeader(record.header)) {
      nodes.push({
        id,
        header: record.header,
        depth: frame.childDepth,
        hasChildren: childIds.some(cid => {
          const child = corpus.get(cid)
          return child !== undefined && isDescendantHeader(child.header)
        }),
      })
    }
    const nextChildDepth = isDescendantHeader(record.header) ? frame.childDepth + 1 : frame.childDepth
    for (let i = childIds.length - 1; i >= 0; i -= 1) {
      const cid = childIds[i]!
      if (!corpus.has(cid)) continue
      stack.push({ id: cid, childDepth: nextChildDepth })
    }
  }
  return nodes
}

/**
 * Canonical zero aggregate (a fresh/unknown root reads as empty rather than
 * erroring; frozen so callers may share one object).
 */
export function EMPTY_SUBAGENTS_STATS(): SubagentsBillingStats {
  return Object.freeze({
    directCount: 0,
    totalCount: 0,
    runningCount: 0,
    requestCount: 0,
    unpricedRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: Object.freeze({}),
    billedCount: Object.freeze({}),
    children: Object.freeze([]),
    truncated: false,
    pendingCount: 0,
  }) as unknown as SubagentsBillingStats
}

/**
 * Aggregate folded rows into the family stats. Totals cover EVERY row handed
 * in — rows already arrive NEWEST-FIRST (the caller sorts before folding, so
 * the wire cap keeps the most recent children). `truncated` flags that the
 * row LIST was cut for the wire while totals still describe the full walk.
 * `pendingCount` reports cold children not folded YET this round (bounded
 * budget): their stats are absent from the totals until later polls drain
 * them. Cost keys merge across currencies without mixing values.
 */
export function aggregateSubagentStats(
  rows: readonly SubagentBillingRow[],
  options: { truncated: boolean; pendingCount?: number },
): SubagentsBillingStats {
  const totals: SubagentsBillingStats = {
    directCount: 0,
    totalCount: rows.length,
    runningCount: 0,
    requestCount: 0,
    unpricedRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: {},
    billedCount: {},
    children: [],
    truncated: false,
    pendingCount: options.pendingCount ?? 0,
  }
  for (const row of rows) {
    if (row.depth === 1) totals.directCount += 1
    if (row.activity === 'running') totals.runningCount += 1
    totals.requestCount += row.requestCount
    totals.unpricedRequestCount += row.unpricedRequestCount
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    for (const [currency, units] of Object.entries(row.cost)) {
      if (!(units > 0)) continue
      totals.cost[currency] = (totals.cost[currency] ?? 0) + units
      // The average-cost denominator counts over the FULL walk, so it stays
      // correct on the wire even when the visible `children` list is cut.
      totals.billedCount![currency] = (totals.billedCount![currency] ?? 0) + 1
    }
  }
  totals.truncated = options.truncated || rows.length > SUBAGENT_ROWS_CAP
  totals.children = rows.length > SUBAGENT_ROWS_CAP ? rows.slice(0, SUBAGENT_ROWS_CAP) : [...rows]
  return totals
}
