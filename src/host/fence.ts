/**
 * Minimal browser-trust fence for /billing/api routes: loopback Host-header
 * passes (the dsh GUI serves localhost), cross-site browser requests refuse.
 * DNS-rebinding defense, not authentication — the GUI is a local surface.
 */
import type { IncomingHttpHeaders } from 'node:http'

/** Request facts the fence reads (structural subset of IncomingMessage). */
export interface FenceRequest {
  headers: IncomingHttpHeaders
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Whether a Host-header authority names the loopback host. */
function isLoopbackAuthority(authority: string): boolean {
  try {
    const url = new URL(`http://${authority}`)
    const hostname = url.hostname
    if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
    const parts = hostname.split('.')
    return parts.length === 4
      && parts[0] === '127'
      && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  } catch {
    return false
  }
}

/** Decide whether one request may reach the billing routes. */
export function billingFence(req: FenceRequest): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  return isLoopbackAuthority(host)
}
