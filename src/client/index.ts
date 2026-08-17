/**
 * Billing client plugin: contributes a persistent session-header action
 * (cost badge + hover card + refresh) and a Billing settings page for the
 * price table. The plugin is a module-table consumer only — it imports no
 * dsh client package values (platform modules + type-only imports only), so
 * its bundle passes the client purity gate as a third-party package.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BillingAction } from './BillingAction.tsx'
import type { BillingActionInjected, BillingActionProps } from './BillingAction.tsx'
import { BillingSettingsSection } from './BillingSettings.tsx'
import type { BillingSettingsInjected, BillingSettingsSectionProps } from './BillingSettings.tsx'
import type { ClientContext } from './context-types.ts'
import { NS, zh, en, type BillingKey } from './locales.ts'

export type { BillingActionProps } from './BillingAction.tsx'
export type { BillingSettingsSectionProps } from './BillingSettings.tsx'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the header action and the settings section.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'billing: copy dictionaries')

  const t = (key: BillingKey): string => ctx.locale.bind(NS)(key)
  const actionInjected = (): BillingActionInjected => ({ t })

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'billing',
    // Rightmost utility in the action row (after subagent catalog and jobs).
    order: 40,
    locale: NS,
    inject: actionInjected,
  }, BillingAction))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'billing',
    order: 90,
    label: () => t('settings.nav'),
    inject: (): BillingSettingsInjected => ({ t }),
  }, BillingSettingsSection))
}
