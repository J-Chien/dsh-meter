/**
 * Pure decision for which model rows a settings save writes into the USER
 * layer, plus the row identity both shapes agree on. Extracted from the
 * settings card because getting it wrong is a silent, durable config change:
 * the editor seeds every catalog row from the RESOLVED table (built-in
 * defaults + the agent-writable price file + explicit config), so writing every
 * seeded row back would pin the whole catalog as explicit layer 1 — and the
 * host lets explicit rows win over the price file, so after one save the file
 * could no longer correct ANY model. That kills the documented "an agent
 * writes prices.yaml" workflow (docs/CONFIGURING.md).
 *
 * The rule: a row reaches the user layer only when the user actually edited it
 * in this draft session, or when the user layer already carries it (an explicit
 * row from an earlier save or a hand-written patch must survive a save that
 * touched other rows). Rows the editor cannot represent at all — providers
 * absent from the live catalog, `reasoningEffort`-keyed rows — are preserved
 * verbatim from the user layer, never re-created from the resolved table.
 */
import type { ModelPrice } from '../shared.ts'

/** One catalog model row's edit state, as the settings card computes it. */
export interface ModelPersistInput {
  /** Row identity: `modelRowKey` of the editor's provider/model. */
  key: string
  /**
   * The row to write, or undefined when the editor carries nothing
   * registerable (all-zero prices, no peak windows, no tiers). An edited row
   * with an undefined `row` is deliberately REMOVED from the user layer.
   */
  row: ModelPrice | undefined
  /** Whether the user touched this row in the current draft session. */
  edited: boolean
}

/**
 * Identity of one persisted model row. `reasoningEffort` is part of the key:
 * the editor cannot represent effort rows, and keying them as the effort-less
 * row would make a catalog row's save delete them.
 */
export function modelRowKey(row: { provider: string; model: string; reasoningEffort?: string }): string {
  return `${row.provider}/${row.model}\u0000${row.reasoningEffort ?? ''}`
}

/**
 * The `models` array to write: rows the user edited, plus the user layer's own
 * rows (verbatim) for everything the editor did not touch — including rows the
 * editor cannot represent.
 * @param inputs - every catalog row the editor shows, edited or not.
 * @param userRows - the raw user layer's models (`snapshot.user.models`).
 * @returns a fresh array; the inputs are not mutated.
 */
export function persistedModelRows(
  inputs: readonly ModelPersistInput[],
  userRows: readonly ModelPrice[],
): ModelPrice[] {
  const userByKey = new Map<string, ModelPrice>()
  for (const row of userRows) userByKey.set(modelRowKey(row), row)
  const out: ModelPrice[] = []
  const represented = new Set<string>()
  for (const input of inputs) {
    represented.add(input.key)
    if (input.edited) {
      if (input.row !== undefined) out.push(input.row)
      continue
    }
    const prior = userByKey.get(input.key)
    if (prior !== undefined) out.push(prior)
  }
  // The editor's blind spots: anything the user layer holds under a key no
  // editor row claims (off-catalog providers, effort-keyed rows) survives.
  for (const row of userRows) {
    if (!represented.has(modelRowKey(row))) out.push(row)
  }
  return out
}
