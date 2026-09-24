/**
 * Smoke test over the SHIPPED artifacts: `lib/index.js` (host) and
 * `lib/client.js` (browser bundle).
 *
 * Why artifacts and not src: `tests/pure-check.ts` and friends prove the
 * algorithms, and the type-checker proves the types, but neither notices a
 * bundle that no longer loads, an export the bundler dropped, a slot id that
 * changed, or a client bundle whose module-loader handoff broke. This runs the
 * real files a profile loads, with the smallest fake host/client surface they
 * touch, and then PRICES A REQUEST through the registered projection — so the
 * price-file layering is asserted on the code path that actually bills.
 *
 * Run: pnpm build && pnpm smoke
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

if (!existsSync(join(process.cwd(), 'lib/index.js'))) {
  console.error('smoke: lib/index.js is missing — run `pnpm build` first (this test exercises the built bundles).')
  process.exit(1)
}

// The BUNDLED artifact, resolved at runtime rather than imported by a static
// specifier: the build writes declarations to lib/types/, so a static import of
// lib/index.js has no types to resolve, and the shape below IS the contract this
// test wants (the point is to check the shipped export surface by hand).
const host = await import(pathToFileURL(join(process.cwd(), 'lib/index.js')).href) as {
  apply: (ctx: unknown, config: unknown) => void
  Config: unknown
  DEFAULT_TABLE: { providers: Record<string, unknown>; models: { provider: string; model: string; input: number; output: number; cacheInput: number }[] }
  BILLING_ID: string
  inject: unknown
}

// ---------------------------------------------------------------------------
// Part A — the host half
// ---------------------------------------------------------------------------

// A harness home of our own, so the default price-file path (which is what the
// host reads when the entry config names none) cannot pick up a real file.
const home = mkdtempSync(join(tmpdir(), 'dsh-meter-smoke-'))
process.env.DSH_HOME = home

/** The fake host surface `apply` touches, with the observations it makes. */
function fakeHost(options: {
  priceFile?: string
  models?: typeof host.DEFAULT_TABLE.models
  base?: unknown
  user?: unknown
}) {
  const routes: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []
  const registrations: Record<string, any>[] = []
  const logs: { level: string; text: string }[] = []
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const disposers: (() => void)[] = []

  const ctx = {
    logger: {
      info: (text: string) => { logs.push({ level: 'info', text }) },
      warn: (text: string) => { logs.push({ level: 'warn', text }) },
    },
    fiber: {},
    settings: {
      configure: () => () => undefined,
      describe: () => [{ ns: options.priceFile === undefined ? 'something-else' : 'billing', base: options.base, user: options.user }],
    },
    effect: (fn: () => unknown) => {
      const off = fn()
      if (typeof off === 'function') disposers.push(off as () => void)
      return () => undefined
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler)
      return () => undefined
    },
    inject: (_deps: string[], cb: (c: unknown) => unknown) => {
      cb({ sessionProjections: { register: (registration: Record<string, any>) => { registrations.push(registration); return () => undefined } } })
    },
    webServer: { register: (route: never) => { routes.push(route); return () => undefined } },
    sessions: { get: () => undefined },
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    get: () => undefined,
  }

  const config = {
    get: () => ({
      providers: host.DEFAULT_TABLE.providers,
      models: options.models ?? host.DEFAULT_TABLE.models,
      ...(options.priceFile === undefined ? {} : { priceFile: options.priceFile }),
    }),
  }
  return { ctx, config, routes, registrations, logs, listeners, disposers }
}

/** Price one request of exactly 1M uncached input tokens through the projection. */
function priceOneMillion(registration: Record<string, any>, provider: string, model: string, time: number): number {
  const init = registration.init()
  const headed = registration.apply(init, {
    type: 'request/header', seq: 0, time, data: { header: { config: { provider, model } }, reason: 'initial' },
  })
  const priced = registration.apply(headed, {
    type: 'assistant/message', seq: 1, time,
    data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  })
  return (priced.stats.cost as Record<string, number>).CNY ?? 0
}

/** POST one /billing/api method through the registered route handler. */
async function callRoute(route: { handler: (req: unknown, res: unknown) => Promise<void> }, method: string, body: Record<string, unknown>) {
  const text = JSON.stringify(body)
  const req = {
    method: 'POST',
    url: `/billing/api/${method}`,
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(text) },
  }
  const out = { statusCode: 0, body: '' }
  const res = {
    set statusCode(code: number) { out.statusCode = code },
    setHeader: () => undefined,
    end: (value: string) => { out.body = value },
  }
  await route.handler(req, res)
  return JSON.parse(out.body) as { ok: boolean; value?: { priceFile?: Record<string, unknown> }; error?: unknown }
}

const OFF_PEAK = Date.parse('2026-08-17T20:00:00+08:00')
const PEAK = Date.parse('2026-08-17T10:00:00+08:00')

// --- A1. The bundle loads, exports its surface, and applies with no file. ---
{
  assert.equal(typeof host.apply, 'function', 'lib/index.js exports apply')
  assert.equal(host.BILLING_ID, 'billing', 'the entry id is stable (the client binds it)')
  assert.equal(Array.isArray(host.DEFAULT_TABLE.models), true, 'the built-in table ships with the bundle')

  const fake = fakeHost({})
  host.apply(fake.ctx, fake.config)

  assert.equal(fake.routes.length, 1, 'the /billing/api route is registered')
  assert.deepEqual(
    [fake.routes[0]?.kind, fake.routes[0]?.path],
    ['prefix', '/billing/api'],
    'as the fenced prefix the client fetches',
  )
  assert.equal(fake.registrations.length, 1, 'one session-projection unit is registered')
  const registration = fake.registrations[0] as Record<string, any>
  assert.equal(registration.key, 'billing', 'keyed `billing` (the client reads that cell)')

  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-flash', OFF_PEAK), 100_000,
    'with no file, the built-in 1 元/M applies (1M input → 1.00 元 = 100000 units)',
  )
  console.log('SMOKE A1 PASSED — host bundle loads, registers, prices from the built-in table')
}

// --- A2. The price file supplies prices, and takes effect without a restart. ---
{
  const file = join(home, 'prices.yaml')
  writeFileSync(file, `
providers:
  deepseek-official: { currency: CNY, currencySymbol: '¥' }
models:
  - provider: deepseek-official
    model: deepseek-flash
    input: 7
    output: 4
    cacheInput: 0.02
`)
  const fake = fakeHost({ priceFile: file })
  host.apply(fake.ctx, fake.config)
  const registration = fake.registrations[0] as Record<string, any>

  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-flash', OFF_PEAK), 700_000,
    'a file price of 7 元/M bills 7.00 元 for 1M input — the file beats the built-in default',
  )
  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-flash', PEAK), 700_000,
    'a row the file gives no peak windows prices flat',
  )
  assert.equal(
    priceOneMillion(registration, 'deepseek-account', 'deepseek-v4-pro', OFF_PEAK), 450_000,
    'a row the file does NOT mention keeps its built-in price (rows are per-key)',
  )

  const catalog = await callRoute(fake.routes[0] as never, 'catalog', {})
  assert.equal(catalog.ok, true, 'the catalog route answers')
  assert.deepEqual(
    catalog.value?.priceFile,
    { path: file, present: true, rows: 1, overridden: 0, errors: [] },
    'and reports the file so the settings card can show it',
  )
  assert.equal(
    fake.logs.some(entry => entry.level === 'info' && entry.text.includes('supplies 1 model row')),
    true,
    'the host logs that a file is supplying prices',
  )
  console.log('SMOKE A2 PASSED — a written file prices requests and is reported to the UI')
}

// --- A3. Explicit configuration wins over the file, per row. ---
{
  const file = join(home, 'pins.yaml')
  writeFileSync(file, `
providers:
  deepseek-official: { currency: CNY, currencySymbol: '¥' }
models:
  - { provider: deepseek-official, model: deepseek-flash, input: 7, output: 4, cacheInput: 0.02 }
  - { provider: deepseek-official, model: deepseek-v4-pro, input: 20, output: 60, cacheInput: 1 }
`)
  // The resolved entry config, as it would be after a profile patch priced
  // flash at 3 元/M but said nothing about v4-pro.
  const models = host.DEFAULT_TABLE.models.map(row =>
    row.provider === 'deepseek-official' && row.model === 'deepseek-flash'
      ? { ...row, input: 300_000, output: 400_000, cacheInput: 2_000 }
      : row)
  const fake = fakeHost({
    priceFile: file,
    models,
    base: { models: [{ provider: 'deepseek-official', model: 'deepseek-flash' }] },
  })
  host.apply(fake.ctx, fake.config)
  const registration = fake.registrations[0] as Record<string, any>

  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-flash', OFF_PEAK), 300_000,
    'a row the entry config states explicitly keeps ITS price — the file cannot silently re-price it',
  )
  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-v4-pro', OFF_PEAK), 2_000_000,
    'while a row the entry config never mentions DOES take the file price (20 元/M)',
  )

  const catalog = await callRoute(fake.routes[0] as never, 'catalog', {})
  assert.equal((catalog.value?.priceFile as { overridden?: number } | undefined)?.overridden, 1,
    'and the override is reported, not silent')
  console.log('SMOKE A3 PASSED — explicit config > price file > built-in defaults')
}

// --- A4. A broken file is ignored whole, with a loud log, and the meter keeps working. ---
{
  const file = join(home, 'broken.yaml')
  writeFileSync(file, `
providers:
  wpsai: { currency: CNY, currencySymbol: '¥' }
models:
  - { provider: wpsai, model: m, input: 300000, output: 1, cacheInput: 0 }
`)
  const fake = fakeHost({ priceFile: file })
  host.apply(fake.ctx, fake.config)
  const registration = fake.registrations[0] as Record<string, any>

  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-flash', OFF_PEAK), 100_000,
    'a refused file leaves the built-in table in place — no half-applied prices',
  )
  assert.equal(
    fake.logs.some(entry => entry.level === 'warn' && entry.text.includes('price file ignored')),
    true,
    'and the reason is logged',
  )
  const catalog = await callRoute(fake.routes[0] as never, 'catalog', {})
  const status = catalog.value?.priceFile as { errors?: string[] } | undefined
  assert.equal((status?.errors?.length ?? 0) > 0, true, 'the catalog surfaces the error for the UI')
  console.log('SMOKE A4 PASSED — a broken file degrades to the built-in table and says so')
}

// --- A5. The file is re-read on the refresh route (no restart needed). ---
{
  const file = join(home, 'live.yaml')
  writeFileSync(file, `
providers:
  deepseek-official: { currency: CNY, currencySymbol: '¥' }
models:
  - { provider: deepseek-official, model: deepseek-flash, input: 2, output: 4, cacheInput: 0.02 }
`)
  const fake = fakeHost({ priceFile: file })
  host.apply(fake.ctx, fake.config)
  assert.equal(
    priceOneMillion(fake.registrations[0] as Record<string, any>, 'deepseek-official', 'deepseek-flash', OFF_PEAK), 200_000,
    'the first read uses the file',
  )
  writeFileSync(file, `
providers:
  deepseek-official: { currency: CNY, currencySymbol: '¥' }
models:
  - { provider: deepseek-official, model: deepseek-flash, input: 5, output: 4, cacheInput: 0.02 }
`)
  // The refresh route re-resolves into the SAME holder the live projection
  // reads, so the already-registered unit bills the edited price. Asserting on
  // that same registration is what proves "no restart": re-applying would only
  // prove a fresh read, which is not the claim.
  const registration = fake.registrations[0] as Record<string, any>
  const refreshed = await callRoute(fake.routes[0] as never, 'refresh', { sessionId: 'unknown' })
  assert.equal(typeof refreshed.ok, 'boolean', 'the refresh route answers without throwing on a file edit')
  assert.equal(
    priceOneMillion(registration, 'deepseek-official', 'deepseek-flash', OFF_PEAK), 500_000,
    'the LIVE projection bills the edited price after a refresh — an agent edit needs no restart',
  )
  assert.equal(
    fake.registrations.length, 2,
    'and the projection was re-registered, so its stateVersion carries the new table revision '
    + '(a stale version would let a checkpoint folded with the old prices be replayed)',
  )
  console.log('SMOKE A5 PASSED — editing the file is picked up by the running projection')
}

// ---------------------------------------------------------------------------
// Part B — the client half, loaded the way the shell loads it
// ---------------------------------------------------------------------------
{
  const loaded: { id?: string; factory?: (require: (spec: string) => unknown) => unknown }[] = []
  const stubs: Record<string, unknown> = {}
  const anyKey = () => new Proxy({}, { get: () => () => null })
  stubs.react = anyKey()
  stubs['react/jsx-runtime'] = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
  stubs['react-dom'] = anyKey()
  stubs['react-dom/client'] = anyKey()
  stubs['@deepseek-ai/dsh-client-ui-primitives'] = anyKey()

  const injected: { name: string; options: Record<string, unknown>; component: unknown }[] = []
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = {
    __ModuleLoader__: { load: (spec: never) => { loaded.push(spec) } },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    dispatchEvent: () => true,
  }
  globals.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {} }),
    head: { appendChild: () => undefined },
  }
  globals.CustomEvent = class { constructor(_type: string, _init?: unknown) {} }

  const requireShim = (spec: string): unknown => {
    if (spec in stubs) return stubs[spec]
    throw new Error(`smoke: the client bundle required an undeclared module "${spec}" — it is not a platform seed word`)
  }
  // The bundle is the shell's CJS handoff: it calls window.__ModuleLoader__.load
  // with `{ id, factory }` and exports whatever the factory returns.
  createRequire(import.meta.url)(join(process.cwd(), 'lib/client.js'))
  assert.equal(loaded.length, 1, 'the client bundle performs exactly one module-loader handoff')
  assert.equal(loaded[0]?.id, 'dsh-meter', 'under the plugin id the shell expects')

  const client = loaded[0]?.factory?.(requireShim) as { inject?: string[]; apply?: (ctx: unknown) => void }
  assert.equal(typeof client?.apply, 'function', 'the client half exports apply')
  assert.deepEqual(client?.inject, ['slots', 'locale', 'configForms'], 'and declares the services it needs')

  const scope = {
    getSnapshot: () => ({ status: 'unavailable', value: undefined, user: undefined, writable: false }),
    subscribe: () => () => undefined,
    set: async () => undefined,
  }
  const clientCtx = {
    effect: (fn: () => unknown) => { fn(); return () => undefined },
    locale: {
      register: () => () => undefined,
      bind: () => (key: string) => key,
    },
    configForms: { get: () => scope },
    slots: {
      inject: (_name: string, cb: () => unknown) => { cb(); return () => undefined },
      register: (options: Record<string, unknown>, component: unknown) => {
        injected.push({ name: String(options.name), options, component })
        return () => undefined
      },
      entries: () => [],
    },
  }
  client?.apply?.(clientCtx)

  assert.deepEqual(
    injected.map(entry => `${entry.name}#${String(entry.options.id)}`),
    ['conversation.session.header.actions#billing', 'settings.plugins.tab#billing'],
    'the bundle registers the header action and the settings tab it promises',
  )
  const component = injected[0]?.component
  assert.equal(
    component !== undefined && (typeof component === 'function' || typeof component === 'object'),
    true,
    'each registration carries a renderable component (not undefined)',
  )
  assert.equal(
    (injected[0]?.options.locale as string | undefined), 'billing',
    'localized through its own dictionary namespace',
  )
  console.log('SMOKE B PASSED — client bundle loads through the module-loader handoff and registers both slots')
}

console.log('ALL SMOKE CHECKS PASSED')
