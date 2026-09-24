/**
 * Billing client plugin: contributes a persistent session-header action
 * (cost badge + hover card + refresh) and a native settings tab (0.1.7-rc.1
 * `settings.plugins.tab`, keyed by the `billing` entry) for the price
 * table. The plugin is a module-table consumer only — it imports no dsh
 * client package values (platform modules + type-only imports only), so
 * its bundle passes the client purity gate as a third-party package.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BillingAction } from './BillingAction.tsx'
import type { BillingActionInjected, BillingActionProps } from './BillingAction.tsx'
import { BillingSettingsCard } from './BillingSettings.tsx'
import type { BillingSettingsInjected, BillingSettingsCardProps } from './BillingSettings.tsx'
import type { ClientContext } from './context-types.ts'
import { attachPricingScope } from './pricing-scope.ts'
import { BILLING_ENTRY_ID } from '../shared.ts'
import type { PriceTable } from '../shared.ts'
import { NS, zh, en, type BillingKey } from './locales.ts'

export type { BillingActionProps } from './BillingAction.tsx'
export type { BillingSettingsCardProps } from './BillingSettings.tsx'

/**
 * Required services (cordis fiber inject). `configForms` is provided by
 * dsh-client-ui-settings (composed in the web profile and declared in this
 * package's dsh.client inject list).
 */
export const inject = ['slots', 'locale', 'configForms']

/**
 * Attach the price-table form, then register the header action and the
 * native settings tab.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'billing: copy dictionaries')

  const t = (key: BillingKey): string => ctx.locale.bind(NS)(key)
  const actionInjected = (): BillingActionInjected => ({ t })

  // The native read/write path for the price table (badge peak tag + settings
  // tab share it; see pricing-scope.ts).
  attachPricingScope(ctx.configForms.get<PriceTable>(BILLING_ENTRY_ID))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'billing',
    // Rightmost utility in the action row (after subagent catalog and jobs).
    order: 40,
    locale: NS,
    inject: actionInjected,
  }, BillingAction))

  // Native settings tab (0.1.7-rc.1): rendered inside the billing plugin's
  // row in the settings panel's plugins section.
  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: BILLING_ENTRY_ID,
    order: 10,
    label: () => t('settings.title'),
    locale: NS,
    inject: (): BillingSettingsInjected => ({ t }),
  }, BillingSettingsCard))
}
