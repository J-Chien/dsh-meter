/**
 * Host plugin Context: the cordis base plus the dsh service faces this
 * plugin consumes, typed from the installed dsh packages (they resolve in
 * the profile where the plugin runs). A third-party package outside the
 * monorepo does not receive the repo's `declare module` augmentations, so
 * the services are declared here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'

/** Host plugin context (structural; the real runtime supplies these). */
export interface HostContext extends Context {
  settings: SettingsProvider
  webServer: WebServer
  sessionProjections: SessionProjectionRegistry
  sessions: SessionStore
  llm: LlmRuntime
}
