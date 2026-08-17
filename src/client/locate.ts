/**
 * Cross-entry "locate a model in the settings page" request. The header card
 * (BillingAction) queues a target before opening settings; the settings
 * section consumes it once it has rendered, then expands the provider and
 * scrolls the model row into view. Module-level because the two entries
 * share no store seat in this third-party bundle; a DOM event covers the
 * already-mounted case, the queue covers a section that mounts afterwards.
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
