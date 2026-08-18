/**
 * Billing client plugin: contributes a persistent session-header action
 * (cost badge + hover card + refresh) and a native settings card (rc.7
 * `settings.plugin.item`, identified by `billing` and bound to the
 * `billing-pricing` namespace) for the price table. The plugin is a
 * module-table consumer only — it imports no dsh client package values
 * (platform modules + type-only imports only), so
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
import { PRICING_NAMESPACE } from '../shared.ts'
import type { PriceTable } from '../shared.ts'
import { NS, zh, en, type BillingKey } from './locales.ts'

export type { BillingActionProps } from './BillingAction.tsx'
export type { BillingSettingsCardProps } from './BillingSettings.tsx'

/**
 * Required services (cordis fiber inject). `connection`/`remote` are resolved
 * by the settingsScope binder through THIS fiber, so they must be injected
 * here even though no code touches them directly.
 */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Attach the price-table scope, then register the header action and the
 * native settings card.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'billing: copy dictionaries')

  const t = (key: BillingKey): string => ctx.locale.bind(NS)(key)
  const actionInjected = (): BillingActionInjected => ({ t })

  // The native read/write path for the price table (badge peak tag + settings
  // card share it; see pricing-scope.ts).
  attachPricingScope(ctx.settingsScope.bind<PriceTable>({ namespace: PRICING_NAMESPACE }))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'billing',
    // Rightmost utility in the action row (after subagent catalog and jobs).
    order: 40,
    locale: NS,
    inject: actionInjected,
  }, BillingAction))

  // Native settings card (rc.7): list slots require a stable id; `key`
  // associates this card with its settings namespace.
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'billing',
    key: PRICING_NAMESPACE,
    locale: NS,
    inject: (): BillingSettingsInjected => ({ t }),
  }, BillingSettingsCard))
}
