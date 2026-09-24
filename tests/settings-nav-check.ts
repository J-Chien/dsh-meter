/**
 * DOM/navigation checks for the settings gear (client half). The gear must
 * reach 设置 → 内置插件 → 计费价格 without the user navigating, and it must
 * never mistake an occupied launcher's menu trigger for the settings trigger.
 *
 * The rc.2 shell registers `sidebar.settings` with a store seat; that seat is
 * the supported route and is asserted first. The DOM fallbacks are asserted
 * with the seat removed, because a shell without one is exactly when they run.
 *
 * Run: node --disable-warning=ExperimentalWarning tests/settings-nav-check.ts
 */
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { attachSettingsNav, openBillingSettings } from '../src/client/settings-nav.ts'
import { consumeLocateModel } from '../src/client/locate.ts'
import type { ClientSlotsService } from '../src/client/context-types.ts'

/**
 * One frame with timer-visible DOM, installed as the module-visible globals.
 * Its `setTimeout` runs each leg as a microtask so the plugin's bounded render
 * wait settles in one tick — otherwise a poll from one scenario would keep
 * polling whatever document the next scenario installed.
 */
function frame(): { document: Document; settle: () => Promise<void> } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  ;(dom.window as unknown as { setTimeout: (fn: () => void) => number }).setTimeout =
    (fn) => { void Promise.resolve().then(fn); return 0 }
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = dom.window
  globals.document = dom.window.document
  globals.CustomEvent = dom.window.CustomEvent
  return {
    document: dom.window.document,
    settle: () => new Promise(resolve => { setTimeout(resolve, 0) }),
  }
}

/** A slots service whose only live behaviour is the seat under test. */
function slotsWith(entries: readonly { store?: unknown }[]): ClientSlotsService {
  return {
    inject: () => () => undefined,
    register: () => () => undefined,
    entries: () => entries,
  }
}

const result: string[] = []

// --- 1. rc.2 seat path: the panel opens ON the Plugins section, and the
//        billing tab is pressed so the editor's panel actually mounts. ---
{
  const { document, settle } = frame()
  const opened: string[] = []
  let tabPresses = 0
  // The launcher is occupied (the real composition): the shell's own dialog
  // trigger is absent, so only the seat can open the panel at all.
  document.body.innerHTML = `
    <div data-slot="sidebar.settings">
      <div data-slot="settings.launcher">
        <button type="button" aria-haspopup="menu">account</button>
      </div>
    </div>
    <div role="tablist">
      <button type="button" role="tab" id="«r0»-tab-inventory">内置插件</button>
      <button type="button" role="tab" id="«r0»-tab-billing">计费价格配置</button>
    </div>`
  const billingTab = [...document.querySelectorAll('button[role="tab"]')]
    .find(tab => tab.id.endsWith('-tab-billing')) as HTMLButtonElement
  billingTab.onclick = () => { tabPresses += 1 }

  attachSettingsNav(slotsWith([{
    store: { create: () => ({ actions: { openSection: (id: string) => { opened.push(id) } } }) },
  }]))
  openBillingSettings({ provider: 'wpsai', model: 'deepseek/deepseek-v4-pro' })
  assert.deepEqual(opened, ['plugins'], 'seat path selects the Plugins section')
  assert.equal(consumeLocateModel()?.model, 'deepseek/deepseek-v4-pro', 'locate request is queued for the card')
  await settle()
  assert.equal(tabPresses, 1, 'billing tab is pressed so its panel mounts')
  result.push('SEAT NAV CHECK PASSED (openSection + billing tab)')
}

// --- 2. No seat, launcher free: the shell's own aria-haspopup="dialog"
//        trigger is pressed, and the conversation column is left alone. ---
{
  const { document, settle } = frame()
  let triggerPresses = 0
  let strayPresses = 0
  document.body.innerHTML = `
    <div data-slot="sidebar.settings">
      <div data-slot="settings.launcher">
        <button type="button" aria-haspopup="dialog">设置</button>
      </div>
    </div>
    <div data-slot="conversation.session.header.actions">
      <button type="button" aria-haspopup="dialog">本轮用量</button>
    </div>`
  const launcherTrigger = document.querySelector(
    '[data-slot="settings.launcher"] button[aria-haspopup="dialog"]',
  ) as HTMLButtonElement
  launcherTrigger.onclick = () => { triggerPresses += 1 }
  const pill = document.querySelector(
    '[data-slot="conversation.session.header.actions"] button',
  ) as HTMLButtonElement
  pill.onclick = () => { strayPresses += 1 }

  attachSettingsNav(slotsWith([]))
  openBillingSettings()
  await settle()
  assert.equal(triggerPresses, 1, 'the shell launcher button opens the panel')
  assert.equal(strayPresses, 0, 'the conversation column is never searched')
  result.push('LAUNCHER FALLBACK CHECK PASSED (scoped dialog trigger)')
}

// --- 3. No seat, launcher occupied: press the menu trigger and its first row.
//        This is the regression the gear shipped with through 0.3.24: it
//        stopped at the menu trigger, so 「设置」 opened 账户菜单 instead of the
//        panel. The stray dialog button below asserts the precedence too — the
//        occupied launcher's menu wins over a blind document-wide sweep. ---
{
  const { document, settle } = frame()
  let menuTriggerPresses = 0
  let menuRowPresses = 0
  let strayPresses = 0
  document.body.innerHTML = `
    <div data-slot="sidebar.settings">
      <div data-slot="settings.launcher">
        <button type="button" aria-haspopup="menu">账户</button>
      </div>
    </div>
    <button type="button" aria-haspopup="dialog">some other dialog opener</button>`
  ;(document.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement).onclick =
    () => { strayPresses += 1 }
  const trigger = document.querySelector(
    '[data-slot="settings.launcher"] button[aria-haspopup="menu"]',
  ) as HTMLButtonElement
  trigger.onclick = () => {
    menuTriggerPresses += 1
    // The real Menu portals its rows on the frame after the trigger press; the
    // frame's microtask scheduler stands in for that frame.
    void Promise.resolve().then(() => {
      const row = document.createElement('button')
      row.setAttribute('role', 'menuitem')
      row.textContent = '设置'
      row.onclick = () => { menuRowPresses += 1 }
      document.body.appendChild(row)
    })
  }

  attachSettingsNav(slotsWith([]))
  openBillingSettings()
  await settle()
  assert.equal(menuTriggerPresses, 1, 'the occupied launcher is pressed')
  assert.equal(menuRowPresses, 1, 'its settings row is pressed, not left open')
  assert.equal(strayPresses, 0, 'the blind sweep does not pre-empt the occupied launcher')
  result.push('OCCUPIED LAUNCHER CHECK PASSED (menu trigger then its first row)')
}

// --- 4. Nothing to drive: the gear must not throw, and the queued locate still
//        lands if the user reaches 内置插件 themselves. ---
{
  const { settle } = frame()
  attachSettingsNav(slotsWith([]))
  openBillingSettings({ provider: 'p', model: 'm' })
  await settle()
  assert.equal(consumeLocateModel()?.provider, 'p', 'locate survives an unopenable panel')
  result.push('NO-TARGET CHECK PASSED (silent, locate preserved)')
}

// --- 5. A foreign store seat (factory-shaped, or one whose actions are not the
//        settings shell's) must not be driven. ---
{
  const { document, settle } = frame()
  let used = 0
  document.body.innerHTML = '<div data-slot="sidebar.settings"></div>'
  attachSettingsNav(slotsWith([
    { store: () => ({ actions: { openSection: () => { used += 1 } } }) },
    { store: { create: () => ({ actions: {} }) } },
  ]))
  openBillingSettings()
  await settle()
  assert.equal(used, 0, 'a seat without a callable openSection is skipped')
  result.push('FOREIGN SEAT CHECK PASSED (shape-tested, never driven blind)')
}

for (const line of result) console.log(line)
console.log('ALL SETTINGS-NAV CHECKS PASSED')
