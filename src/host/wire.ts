/**
 * Minimal HTTP wire helpers for the /billing/api JSON routes (modeled on the
 * reference third-party plugin's own wire layer; node:http types only).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** A route failure with a stable machine code and HTTP status. */
export class BillingRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/** Read and JSON-parse a request body (bounded). */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > 1_000_000) throw new BillingRouteError('body-too-large', 'request body too large', 413)
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new BillingRouteError('bad-json', 'invalid JSON body', 400)
  }
}

/** Write a JSON response with the given status. */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(text)
}

/** Write a successful envelope `{ ok: true, value }`. */
export function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write a failure envelope from an error. */
export function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof BillingRouteError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}
