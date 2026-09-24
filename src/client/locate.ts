/**
 * Cross-entry "locate a model in the settings card" request. The header card
 * (BillingAction) queues a target before opening the settings panel; the
 * settings card consumes it once it has rendered — the gear itself selects the
 * Plugins section and presses the billing tab (settings-nav.ts), so the card
 * mounts without the user navigating — and then expands the provider group and
 * scrolls the model row into view.
 * Module-level because the two entries share no store seat in this
 * third-party bundle; a DOM event covers the already-mounted case, the queue
 * covers a card that mounts afterwards.
 */

/** One locate request: expand `provider` and reveal its `model` row. */
export interface LocateModelRequest {
  provider: string
  model: string
}

/** Window event name for live locate requests. */
export const LOCATE_EVENT = 'billing:locate-model'

let pending: LocateModelRequest | undefined

/** Queue a locate request for the next settings-section render. */
export function requestLocateModel(target: LocateModelRequest): void {
  pending = target
  window.dispatchEvent(new CustomEvent<LocateModelRequest>(LOCATE_EVENT, { detail: target }))
}

/** Take (and clear) the queued request, if any. */
export function consumeLocateModel(): LocateModelRequest | undefined {
  const request = pending
  pending = undefined
  return request
}
