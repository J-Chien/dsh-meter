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
export type ClientContext = Omit<Context, 'slots' | 'locale'> & {
  slots: ClientSlotsService
  locale: ClientLocaleService
}
