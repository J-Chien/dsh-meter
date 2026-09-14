/**
 * IO half of subagent billing: enumerate one root session's subagent tree
 * from the live store + optional persistence and fold each child's OWN log
 * with the same price table as the parent's billing. Pure halves (discovery,
 * activity judging, aggregation) live in `subagent-pure.ts`.
 *
 * Performance contract (a 340-child session folds GBs of logs across a full
 * bill — this route shares the host's main thread, so nothing here may stall
 * it): every child's fold is CACHED by a watermark — live children by their
 * folded event seq, cold children by the persistence revision token — plus a
 * price-table fingerprint. Unchanged children serve from cache at zero fold
 * cost; cold reads are budgeted per request (`COLD_FOLD_BUDGET`), leftovers
 * report `pendingCount` and drain on later polls. The wire row list is cut
 * to SUBAGENT_ROWS_CAP keeping the NEWEST children.
 */
import type { SessionEvent, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { foldBilling } from './session-stats.ts'
import type { PriceTable } from '../shared.ts'
import type { SubagentBillingRow, SubagentsBillingStats } from '../shared.ts'
import {
  discoverSubagentNodes, hasOpenTurn, aggregateSubagentStats,
  EMPTY_SUBAGENTS_STATS, type SubagentCorpusRecord,
} from './subagent-pure.ts'

/** The seams the route reads: both optional — absent persistence means
 *  live-only enumeration (cold children simply do not appear), matching how
 *  harness listChildren treats capability absence. */
export interface SubagentSources {
  sessions?: SessionStore | undefined
  persistence?: SessionPersistence | undefined
}

/** How many UNCACHED cold children may be persisted-inspected and folded per
 *  request. Everything past the budget reports `pendingCount` for later
 *  polls to drain (an open card polls while anything is running anyway). */
const COLD_FOLD_BUDGET = 24

/** One cached child fold keyed by its log watermark. */
interface CachedFold {
  /** Live: event count already folded; cold: persistence revision token. */
  watermark: string
  /** Price-table fingerprint the fold used (a stale one → refold). */
  tableFingerprint: number
  row: SubagentBillingRow
}

/** Per-root fold cache; rows embed root-relative facts (depth/hasChildren). */
const caches = new Map<string, Map<string, CachedFold>>()

/**
 * Read the durable creation label off a child log's LAST descriptor event.
 * One-shot children may omit it (the card falls back to a short id). Read
 * inline instead of importing dsh-subagent's pure helper: the plugin keeps
 * dsh-subagent out of its dependency table, and the wire shape is stable
 * persisted data. NOTE the `subagent/descriptor` type tag lives on the EVENT
 * ENVELOPE (dsh-subagent merges it into SessionEventMap, which is not in
 * this plugin's compile scope); the label sits on its `data`.
 */
function readLabel(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const env = events[i] as { type?: unknown; data?: { label?: unknown } } | undefined
    if (env?.type !== 'subagent/descriptor') continue
    if (typeof env.data?.label === 'string' && env.data.label !== '') return env.data.label
  }
  return undefined
}

function foldRow(node: {
  id: string
  depth: number
  hasChildren: boolean
  activity: SubagentBillingRow['activity']
  events: readonly SessionEvent[]
}, table: PriceTable): SubagentBillingRow {
  const stats = foldBilling(node.events, table)
  const label = readLabel(node.events)
  return {
    sessionId: node.id,
    ...(label !== undefined ? { label } : {}),
    depth: node.depth,
    hasChildren: node.hasChildren,
    activity: node.activity,
    requestCount: stats.requestCount,
    unpricedRequestCount: stats.unpricedRequestCount,
    inputTokens: stats.uncachedInputTokens + stats.cacheReadTokens + stats.cacheWriteTokens,
    outputTokens: stats.outputTokens,
    cost: stats.cost,
  }
}

/** Read one stored session's FULL event log through the SessionHandle seam
 *  (dsh ≥ 0.1.5-rc.1: `persistence.inspect` was removed; reads now open a
 *  read handle and `read()` it, and the handle must be closed). Cancellation
 *  is observed both at open and at read; close is always attempted. */
async function readStoredEvents(
  persistence: SessionPersistence,
  id: string,
  signal?: AbortSignal,
): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(id as never, 'read', { signal })
  try {
    const inspected = await handle.read(undefined, undefined, { signal })
    return inspected.events
  } finally {
    await handle.close()
  }
}

export { EMPTY_SUBAGENTS_STATS }

/** FNV-1a fingerprint of the resolved price table, for cache invalidation. */
function tableFingerprint(table: PriceTable): number {
  const text = JSON.stringify(table)
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Copy a cached row with THIS walk's tree position (depth/children flags
 *  can change between requests when the family shape changes). */
function withTree(row: SubagentBillingRow, node: {
  depth: number
  hasChildren: boolean
}): SubagentBillingRow {
  if (row.depth === node.depth && row.hasChildren === node.hasChildren) return row
  return { ...row, depth: node.depth, hasChildren: node.hasChildren }
}

/**
 * Route entry: aggregate one root's whole subagent tree into totals + rows.
 *
 * Live children fold synchronously from their in-memory logs (an unchanged
 * watermark serves from cache at zero cost; only the changed child refolds).
 * Cold children each need one persistence inspection — bounded per request
 * (COLD_FOLD_BUDGET) and answered immediately; anything still unfunded is
 * then warmed up in the BACKGROUND (slice-per-macrotask so the host's main
 * thread breathes between slices), so a family whose card was opened once
 * reaches a fully cached state without any further visible cost. An unknown
 * root yields the canonical zero.
 */
export async function subagentsForSession(
  sessionId: string,
  sources: SubagentSources,
  table: PriceTable,
  signal?: AbortSignal,
): Promise<SubagentsBillingStats> {
  const sessions = sources.sessions
  if (sessions === undefined || sessions.get(sessionId as never) === undefined) {
    return EMPTY_SUBAGENTS_STATS()
  }

  // Live-preferred corpus over both sources (same merge order as harness
  // listChildren): persistence seeds it, live records win their id wholesale.
  const corpus = new Map<string, SubagentCorpusRecord>()
  const revisions = new Map<string, string>()
  if (sources.persistence !== undefined) {
    try {
      // dsh ≥ 0.1.5-rc.1: listSnapshots() became list() (sessions are now
      // addressed through SessionHandles); the snapshot shape is unchanged.
      for (const snap of await sources.persistence.list({ signal })) {
        corpus.set(snap.header.id, { header: snap.header })
        revisions.set(snap.header.id, String(snap.revision))
      }
    } catch {
      // Listing failure degrades to live-only rather than failing the card;
      // the tree then covers what is (or was) resident this process.
    }
  }
  for (const session of sessions.list()) corpus.set(session.header.id, { header: session.header })

  const nodes = discoverSubagentNodes(corpus, sessionId)
  const liveById = new Map(sessions.list().map(session => [session.header.id as string, session] as const))

  let cache = caches.get(sessionId)
  if (cache === undefined) {
    cache = new Map()
    caches.set(sessionId, cache)
  }
  const fingerprint = tableFingerprint(table)

  // Live children: sync fold, incremental via seq watermark. A cold child's
  // live appearance (resume) also rides this path once it re-enters the
  // store — its old cache entry's watermark just won't match anymore.
  const liveRows: SubagentBillingRow[] = []
  const coldPending: { id: string; createdAt: number; depth: number; hasChildren: boolean }[] = []
  for (const node of nodes) {
    const session = liveById.get(node.id)
    if (session !== undefined) {
      // Event seq contiguity makes the log length the exact folded position.
      const watermark = String(session.seq)
      const cached = cache.get(node.id)
      if (cached !== undefined && cached.watermark === watermark && cached.tableFingerprint === fingerprint) {
        liveRows.push(withTree(cached.row, node))
        continue
      }
      const row = foldRow({
        id: node.id,
        depth: node.depth,
        hasChildren: node.hasChildren,
        activity: hasOpenTurn(session.snapshotEvents()) ? 'running' : 'inactive',
        events: session.snapshotEvents(),
      }, table)
      cache.set(node.id, { watermark, tableFingerprint: fingerprint, row })
      liveRows.push(row)
    } else {
      coldPending.push({ id: node.id, createdAt: node.header.createdAt, depth: node.depth, hasChildren: node.hasChildren })
    }
  }

  // Cold children: newest first fills the visible window fastest; a bounded
  // budget keeps any single request off the hot path for too long.
  coldPending.sort((a, b) => b.createdAt - a.createdAt)
  const coldRows: SubagentBillingRow[] = []
  const stillCold: typeof coldPending = []
  const persistence = sources.persistence
  let budgetLeft = COLD_FOLD_BUDGET
  for (const node of coldPending) {
    if (signal?.aborted) break
    const cached = cache.get(node.id)
    if (cached !== undefined && cached.tableFingerprint === fingerprint && revisions.get(node.id) !== undefined
      && cached.watermark === revisions.get(node.id)) {
      coldRows.push(withTree(cached.row, node))
      continue
    }
    if (persistence === undefined || budgetLeft <= 0) {
      stillCold.push(node)
      continue
    }
    try {
      const events = await readStoredEvents(persistence, node.id, signal)
      const row = foldRow({
        id: node.id,
        depth: node.depth,
        hasChildren: node.hasChildren,
        activity: 'cold',
        events,
      }, table)
      cache.set(node.id, {
        watermark: revisions.get(node.id) ?? '',
        tableFingerprint: fingerprint,
        row,
      })
      coldRows.push(row)
      budgetLeft -= 1
    } catch {
      // Per-child isolation: a vanished or unreadable child omits its row;
      // later polls simply try again.
    }
  }

  const rowsByCreatedDesc = [...liveRows, ...coldRows].sort((a, b) => {
    const ca = corpus.get(a.sessionId)?.header.createdAt ?? 0
    const cb = corpus.get(b.sessionId)?.header.createdAt ?? 0
    return cb - ca || b.sessionId.localeCompare(a.sessionId)
  })

  // Anything still unfunded warms up in the background so the NEXT card open
  // (or poll, while the client keeps one running for pendingCount > 0) sees
  // the complete, exact family bill. Slices yield to the main thread between
  // persistence inspections; one root warms at a time (a newer request
  // replaces an older pending warmer).
  if (stillCold.length > 0 && persistence !== undefined && !signal?.aborted) {
    scheduleWarm(sessionId, sources, stillCold)
  }

  return aggregateSubagentStats(rowsByCreatedDesc, {
    truncated: liveRows.length + coldRows.length < nodes.length,
    pendingCount: stillCold.length,
  })
}

/** One warmer per root: a later request replaces the previous queue. */
const warmers = new Map<string, { id: string; createdAt: number; depth: number; hasChildren: boolean }[]>()

/** Background warm task, sliced so each persistence inspection + fold gets
 *  its own macrotask and the host's main thread stays responsive between.
 *  Queue entries carry the tree position captured at discovery time, so no
 *  re-walk is needed; a superseded root (new request re-queued it) aborts
 *  quietly — the route's own budget continues the work. */
function scheduleWarm(
  sessionId: string,
  sources: SubagentSources,
  queue: { id: string; createdAt: number; depth: number; hasChildren: boolean }[],
): void {
  warmers.set(sessionId, queue)
  if (warmers.size > 1) return // an existing drain loop will pick this up
  const drain = (): void => {
    const entry = warmers.entries().next()
    if (entry.done || entry.value === undefined) return
    const rootId = entry.value[0]
    const pending = entry.value[1]
    if (pending.length === 0) {
      warmers.delete(rootId)
      setImmediate(drain)
      return
    }
    const batch = pending.splice(0, COLD_FOLD_BUDGET)
    void (async () => {
      const table = currentTable()
      if (table === undefined) return
      const fingerprint = tableFingerprint(table)
      let cache = caches.get(rootId)
      if (cache === undefined) {
        cache = new Map()
        caches.set(rootId, cache)
      }
      const revisions = new Map<string, string>()
      if (sources.persistence !== undefined) {
        try {
          for (const snap of await sources.persistence.list()) {
            revisions.set(snap.header.id, String(snap.revision))
          }
        } catch { /* the per-child read below still tries */ }
      }
      for (const node of batch) {
        if (warmers.get(rootId) !== pending && pending.length !== 0) break // superseded
        try {
          const events = await readStoredEvents(sources.persistence!, node.id)
          const row = foldRow({
            id: node.id,
            depth: node.depth,
            hasChildren: node.hasChildren,
            activity: 'cold',
            events,
          }, table)
          cache.set(node.id, {
            watermark: revisions.get(node.id) ?? '',
            tableFingerprint: fingerprint,
            row,
          })
        } catch { /* drop the child; its row returns on a later poll */ }
        // Yield between children: the main thread breathes between every
        // persistence read + fold so interactive work never queues behind a
        // long warm run.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      setImmediate(drain) // next root's batch, if any
    })()
  }
  setImmediate(drain)
}

/** The table the route currently serves (wired by index.ts at apply time). */
let currentTable: () => PriceTable | undefined = () => undefined

/** Give the warmer the same price-table getter the synchronous route uses. */
export function setSubagentTableSource(get: () => PriceTable | undefined): void {
  currentTable = get
}

