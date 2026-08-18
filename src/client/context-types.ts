/**
 * Minimal local client-context face (structural mirror of the client
 * runtime's services), following the reference third-party plugin's pattern:
 * a third-party package resolves outside the monorepo's single cordis
 * instance, so the upstream `declare module` augmentations do not reach it.
 * Only the members this plugin uses are declared.
 */
import type { Context } from '@deepseek-ai/cordis'

/** The slots service face this plugin uses. */
export interface ClientSlotsService {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** The locale service face this plugin uses. */
export interface ClientLocaleService {
  register(ns: string, dict: Record<string, unknown>): () => void
  bind(ns: string): (key: string) => string
}

/** Client plugin context (structural subset of the runtime's ClientContext). */
export type ClientContext = Omit<Context, 'slots' | 'locale' | 'settingsScope'> & {
  slots: ClientSlotsService
  locale: ClientLocaleService
  settingsScope: ClientSettingsScopeBinder
}

/** Snapshot of one settings-namespace binding (structural mirror of the
 *  runtime's SettingsScopeSnapshot; only the members this plugin uses). */
export interface ClientScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section (the effective price table). */
  value: T | undefined
  /** Raw user layer; a field's PRESENCE here marks it overridden. */
  user: unknown
  /** Whether the Host document accepts writes (false for remote browsers). */
  writable: boolean
}

/** Reactive binding over one settings namespace (native since rc.7). */
export interface ClientSettingsScope<T> {
  getSnapshot(): ClientScopeSnapshot<T>
  subscribe(listener: () => void): () => void
  /** Queue one top-level field write; a rejected write re-reads instead of
   *  throwing — confirm by re-inspecting the user layer after settlement. */
  set(field: string, value: unknown): Promise<void>
}

/** The settingsScope service: binds namespaces, resolving connection/remote
 *  through the caller's fiber (hence the plugin's own inject list). */
export interface ClientSettingsScopeBinder {
  bind<T>(spec: { namespace: string }): ClientSettingsScope<T>
}
