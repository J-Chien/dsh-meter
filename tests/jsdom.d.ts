/**
 * Minimal jsdom ambient types for the client-side checks. jsdom 29 ships no
 * declarations, and the plugin deliberately keeps `@types/jsdom` out of its
 * install surface (its `prepare` script runs on every git install, so every
 * devDependency is a cost paid by users), so only the members the checks touch
 * are declared here. This file is test-only: tsconfig.build.json includes
 * `src` alone.
 */
declare module 'jsdom' {
  /** The subset of the jsdom API the client checks use. */
  export class JSDOM {
    constructor(html?: string, options?: { url?: string })
    readonly window: Window & typeof globalThis
  }
}
