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
  if (host === undefined || !isLoopbackAuthority(host)) return false
  // CSRF hardening on top of the loopback fence (every route is a POST that
  // mutates local settings):
  //  - a browser fetch that crosses sites is marked `sec-fetch-site:
  //    cross-site` — refuse it outright (same-origin/same-site/none pass);
  //  - every route consumes a JSON body, so demand the JSON content type: a
  //    cross-origin form / no-cors POST cannot set `application/json`, and
  //    setting it from another origin triggers a CORS preflight this server
  //    never answers — either way the write never lands.
  const secFetchSite = header(req.headers, 'sec-fetch-site')
  if (secFetchSite !== undefined
    && secFetchSite !== 'same-origin'
    && secFetchSite !== 'same-site'
    && secFetchSite !== 'none') return false
  const contentType = header(req.headers, 'content-type')
  if (contentType === undefined || !contentType.startsWith('application/json')) return false
  return true
}
