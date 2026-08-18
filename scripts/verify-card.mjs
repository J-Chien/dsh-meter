#!/usr/bin/env node
/**
 * Render-regression sanity check: opens the DSH GUI in headless Chrome,
 * enters a session, hovers the billing badge to open the card, and asserts
 * that the context-usage progress bar is actually VISIBLE (its fill overlaps
 * the track box and is painted).
 *
 * Motivation (docs/postmortem/2026-08-18-context-bar-regression.md): the
 * context bar once rendered in the DOM but was clipped out of view — the
 * fill sat 18px below the 4px `overflow:hidden` track because a Tooltip
 * wrapper span became an in-flow sibling. Pure-logic tests never catch this
 * class of CSS layout regression; only geometry does.
 *
 * Fails (exit 1) when:
 *  - the billing trigger is missing / not visible, or
 *  - the card's context track+fill are absent, or
 *  - the fill does not overlap the track (gap !== 0), or
 *  - the fill is invisible (0 size / display:none / hidden / transparent).
 *
 * Usage:
 *   node scripts/verify-card.mjs [--url http://127.0.0.1:3080] [--session-hint 你是不是]
 *   Requires a running `dsh web` GUI and Google Chrome.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

// `ws` ships in the harness profile; use it via createRequire so this script
// needs no local install. Falls back to a clear error if unavailable.
let WebSocket
try {
  const require = createRequire(import.meta.url)
  // Try the harness checkout first, then the profile, then a bare require.
  for (const base of [
    '/Users/jamie/.npm/_npx/1e7f6d9597241db0/package.json',
    process.env.DSH_HARNESS_ROOT ? `${process.env.DSH_HARNESS_ROOT}/package.json` : null,
  ].filter(Boolean)) {
    try { WebSocket = createRequire(base)('ws'); break } catch { /* next */ }
  }
  if (!WebSocket) WebSocket = require('ws')
} catch {
  console.error('This script needs the "ws" package (present in the dsh harness/profile node_modules).')
  process.exit(2)
}

const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEFAULT_URL = process.env.DSH_URL ?? 'http://127.0.0.1:3080'
const DEFAULT_HINT = process.env.SESSION_HINT ?? '你是不是'
const PORT = Number(process.env.CDP_PORT ?? 9347)
const PROFILE = `/tmp/dsh-verify-${process.pid}`

let APP_URL = DEFAULT_URL
let SESSION_HINT = DEFAULT_HINT
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') APP_URL = args[i + 1] ?? APP_URL
  else if (args[i] === '--session-hint') SESSION_HINT = args[i + 1] ?? SESSION_HINT
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (!existsSync(CHROME)) {
    console.error(`Chrome not found at ${CHROME}. Set CHROME_BIN to override.`)
    process.exit(2)
  }
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-crash-reporter', '--disable-background-networking',
    'about:blank',
  ], { stdio: 'ignore' })

  let pages
  for (let i = 0; i < 60 && !pages; i += 1) {
    try { const res = await fetch(`http://127.0.0.1:${PORT}/json/list`); if (res.ok) pages = await res.json() } catch { /* retry */ }
    if (!pages) await wait(500)
  }
  if (!pages) {
    console.error('headless Chrome did not start')
    child.kill()
    process.exit(2)
  }
  const page = pages.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })

  let msgId = 0
  const pending = new Map()
  ws.on('message', (data) => {
    const msg = JSON.parse(typeof data === 'string' ? data : data.toString())
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.result?.exceptionDetails) return undefined
    return r.result?.result?.value
  }

  try {
    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: APP_URL })
    await wait(9000)

    // Enter a session (click the row whose title matches SESSION_HINT).
    const entered = await ev(`(() => {
      const all = [...document.querySelectorAll('*')]
      const row = all.find(el => el.children.length === 0 && (el.textContent || '').includes(${JSON.stringify(SESSION_HINT)}))
      if (!row) return false
      let target = row
      for (let i = 0; i < 6 && target; i++) {
        if (target.onclick || target.getAttribute('role') === 'button' || target.tagName === 'BUTTON' || target.getAttribute('tabindex') !== null) break
        target = target.parentElement
      }
      const r = target.getBoundingClientRect()
      for (const t of ['mousedown', 'mouseup', 'click']) {
        target.dispatchEvent(new MouseEvent(t, { bubbles: true, clientX: r.x + 10, clientY: r.y + r.height / 2 }))
      }
      return true
    })()`)
    if (!entered) { console.error(`FAIL: session matching "${SESSION_HINT}" not found on the workspace view. Set --session-hint.`); process.exit(1) }
    await wait(6000)

    const trig = await ev(`(() => {
      const b = document.querySelector('[data-billing-trigger]')
      if (!b) return { found: false }
      const r = b.getBoundingClientRect()
      return { found: true, visible: r.width > 0 && r.height > 0 }
    })()`)
    if (!trig.found || !trig.visible) { console.error('FAIL: billing trigger not found/visible.'); process.exit(1) }

    await ev(`(() => {
      const b = document.querySelector('[data-billing-trigger]')
      const r = b.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      for (const t of ['pointermove', 'pointerover', 'pointerenter', 'mouseover', 'mousemove']) {
        b.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true }))
      }
    })()`)
    await wait(800)

    const result = await ev(`(() => {
      const track = document.querySelector('._8mxLoW_contextTrack')
      const fill = document.querySelector('._8mxLoW_contextFill')
      if (!track || !fill) return { ok: false, reason: 'context track/fill not in DOM' }
      const tr = track.getBoundingClientRect(); const fr = fill.getBoundingClientRect()
      const cs = getComputedStyle(fill)
      const overlap = fr.y >= tr.y && fr.y < tr.y + tr.height
      const visible = overlap && fr.width > 0 && fr.height > 0
        && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
      return {
        ok: visible,
        trackY: Math.round(tr.y), trackH: Math.round(tr.height),
        fillY: Math.round(fr.y), fillW: Math.round(fr.width), fillH: Math.round(fr.height),
        gap: Math.round(fr.y - tr.y), fillPosition: cs.position, fillVisible: visible,
      }
    })()`)
    if (!result.ok) { console.error('FAIL: context progress bar is not visible.\n' + JSON.stringify(result, null, 2)); process.exit(1) }
    console.log('PASS: context progress bar visible —', JSON.stringify(result))
  } finally {
    try { ws.close() } catch {}
    child.kill()
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
