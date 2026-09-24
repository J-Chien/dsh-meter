/**
 * Cross-entry navigation into the settings panel: the header card's gear must
 * land on 设置 → 内置插件 → 计费价格, and — when a current model is known — on
 * that model's row there.
 *
 * Three seams, in order of preference:
 *
 *  1. The settings shell's STORE SEAT. dsh 0.1.7-rc.2 registers
 *     `sidebar.settings` with `store:`, and that handle's `openSection(id)`
 *     opens the panel with a section selected. `slots.entries(key)` is the
 *     public snapshot that carries the seat, and it is the only
 *     harness-supported way to select a section — there is **no**
 *     settings-navigation service. rc.1 declared no seat, hence the DOM
 *     fallbacks below.
 *  2. The shell's own launcher button (`aria-haspopup="dialog"`), which the
 *     settings shell renders only while nothing else occupies
 *     `settings.launcher`.
 *  3. A launcher that IS occupied — today `client-ui-settings-account`'s
 *     account menu (`aria-haspopup="menu"`): press it, then its first menu row,
 *     which that launcher orders as 「设置」. Until 0.3.25 the gear stopped at
 *     this trigger and opened the account menu instead of the panel.
 *
 * Selecting the section is not enough for the editor to exist: the Plugins
 * section mounts a tab's panel only once that tab was selected, so the billing
 * tab has to be pressed too. Its button carries the shell's stable
 * `id="<tabsId>-tab-<contribution id>"` shape, hence the suffix lookup.
 * Everything after that is the card's own locate handling (expand the provider
 * group, scroll the model row into view).
 */
import { BILLING_ENTRY_ID } from '../shared.ts'
import { requestLocateModel } from './locate.ts'
import type { ClientSlotsService } from './context-types.ts'

/** Slot whose registrant owns the settings dialog's open state and section. */
const SETTINGS_SLOT = 'sidebar.settings'
/** The settings section hosting the price editor. */
const PLUGINS_SECTION = 'plugins'
/** Suffix of the billing tab's button id (`<tabsId>-tab-<contribution id>`). */
const BILLING_TAB_SUFFIX = `-tab-${BILLING_ENTRY_ID}`
/** Bounded render wait: the panel, its section, and its tabs mount across frames. */
const RENDER_INTERVAL_MS = 50
const RENDER_TRIES = 40

/**
 * The settings shell's store seat, read structurally: the real declaration
 * lives in the shell's own package, which this third-party bundle cannot
 * import (platform modules only). A shell that declares no seat — or a factory
 * seat, whose call returns the handle rather than an instance — simply fails
 * the shape test and the DOM fallbacks take over.
 */
interface ShellStoreSeat {
  create?: () => { actions?: { openSection?: (id: string) => void } } | undefined
}

let slots: ClientSlotsService | undefined

/** Capture the slots service, so the gear can reach the shell's seat. */
export function attachSettingsNav(service: ClientSlotsService): void {
  slots = service
}

/** Open the settings panel with the Plugins section selected, via the shell's seat. */
function openPluginsSection(): boolean {
  // Guarded rather than assumed: `entries` is the newer end of the slots
  // service, and a gear that throws would take the whole header entry down.
  const entries = typeof slots?.entries === 'function' ? slots.entries(SETTINGS_SLOT) : []
  for (const entry of entries) {
    const seat = entry.store as ShellStoreSeat | undefined
    if (typeof seat?.create !== 'function') continue
    try {
      const openSection = seat.create()?.actions?.openSection
      if (typeof openSection !== 'function') continue
      openSection(PLUGINS_SECTION)
      return true
    } catch {
      // A seat this plugin cannot drive is not the settings shell's; try the next.
    }
  }
  return false
}

/**
 * The settings launcher button the shell renders inside the launcher seat.
 * Scoped, because `settings.launcher` is the seat that button belongs to.
 */
function launcherTrigger(): HTMLButtonElement | undefined {
  const launcher = document.querySelector('[data-slot="settings.launcher"]')
  return launcher?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]') ?? undefined
}

/**
 * A settings trigger found anywhere on the frame — the shape used before the
 * launcher got its own slot outlet. Last resort, and deliberately blind to the
 * conversation column, where unlabelled dialog pills (the turn-usage pill that
 * once hijacked this gear) live.
 */
function anyDialogTrigger(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
    .find(button => !button.hasAttribute('data-billing-trigger')
      && button.closest('[data-slot^="conversation."]') === null)
}

/** Press an occupied launcher and its first menu row (that launcher orders 设置 first). */
function openFromOccupiedLauncher(): boolean {
  const launcher = document.querySelector('[data-slot="settings.launcher"]')
  const trigger = launcher?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
  if (trigger === undefined || trigger === null) return false
  trigger.click()
  pressFirstMenuRow(RENDER_TRIES)
  return true
}

/** The menu row is portalled on the frame after the trigger press. */
function pressFirstMenuRow(tries: number): void {
  const row = document.querySelector<HTMLElement>('button[role="menuitem"]')
  if (row !== null) {
    row.click()
    return
  }
  if (tries <= 0) return
  window.setTimeout(() => { pressFirstMenuRow(tries - 1) }, RENDER_INTERVAL_MS)
}

/**
 * Press the billing tab so the section mounts the price editor. Absent is a
 * normal outcome — the section renders a single contribution as its page, with
 * no tablist at all — so the wait is bounded and silent.
 */
function pressBillingTab(tries: number): void {
  const tab = document.querySelector<HTMLButtonElement>(`button[role="tab"][id$="${BILLING_TAB_SUFFIX}"]`)
  if (tab !== null) {
    tab.click()
    return
  }
  if (tries <= 0) return
  window.setTimeout(() => { pressBillingTab(tries - 1) }, RENDER_INTERVAL_MS)
}

/**
 * Open the settings panel on the price editor, optionally locating a model.
 *
 * The locate request is queued BEFORE the panel opens: the card consumes it on
 * mount, and the window event covers the already-mounted case.
 *
 * @param model - the current model to reveal once the editor mounts.
 */
export function openBillingSettings(model?: { provider: string; model: string }): void {
  if (model !== undefined) requestLocateModel(model)
  if (openPluginsSection()) {
    pressBillingTab(RENDER_TRIES)
    return
  }
  // The seat is the only route that can also select the section; every
  // fallback below merely opens the panel, so the user may still have to press
  // 内置插件. The queued locate lands either way.
  const scoped = launcherTrigger()
  if (scoped !== undefined) {
    scoped.click()
    pressBillingTab(RENDER_TRIES)
    return
  }
  if (openFromOccupiedLauncher()) {
    pressBillingTab(RENDER_TRIES)
    return
  }
  const legacy = anyDialogTrigger()
  if (legacy !== undefined) legacy.click()
}
