/**
 * The client-wide `settingsScope` binding for the `billing-pricing`
 * namespace, attached once by the client plugin's apply() and shared by the
 * header badge (peak tag) and the settings card (price editor). Module-level
 * like locate.ts: the slot entries share no store seat in this third-party
 * bundle.
 *
 * This is the native rc.7 read/write path for the price table — the binding
 * mirrors the Host document live (settings/document-updated + connection
 * resets), so a save in any tab or window re-seeds every subscriber without
 * the old window-event/localStorage broadcast.
 */
import { useSyncExternalStore } from 'react'
import type { ClientSettingsScope, ClientScopeSnapshot } from './context-types.ts'
import type { PriceTable } from '../shared.ts'

let scope: ClientSettingsScope<PriceTable> | undefined

/** Attach the namespace binding (called once from apply). */
export function attachPricingScope(bound: ClientSettingsScope<PriceTable>): void {
  scope = bound
}

/** The raw scope, for writers (the settings card's save). */
export function pricingScope(): ClientSettingsScope<PriceTable> {
  if (scope === undefined) throw new Error('billing: pricing scope not attached')
  return scope
}

/** Stable fallback before attach / on non-loopback browsers. */
const UNAVAILABLE: ClientScopeSnapshot<PriceTable> = {
  status: 'unavailable',
  value: undefined,
  user: undefined,
  writable: false,
}

/** Subscribe to the live price-table snapshot (badge + card). */
export function usePricingSnapshot(): ClientScopeSnapshot<PriceTable> {
  return useSyncExternalStore(
    (listener) => scope?.subscribe(listener) ?? (() => undefined),
    () => scope?.getSnapshot() ?? UNAVAILABLE,
  )
}

/** The effective price table once ready, else undefined (loading/remote). */
export function usePricingTable(): PriceTable | undefined {
  const snapshot = usePricingSnapshot()
  return snapshot.status === 'ready' ? snapshot.value : undefined
}
