/**
 * tsdown config for a third-party dsh plugin package. Emits:
 *  - lib/index.js  — node-half ESM library (bundled from tsc output in
 *    lib/types/index.js; dsh peer deps stay external, resolved from the
 *    profile's installed packages),
 *  - lib/client.js — browser CJS bundle stamped with the __ModuleLoader__.load
 *    handoff and inline CSS-module styles (the harness client-bundle shape).
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, basename, resolve, sep, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

const ID = 'dsh-meter'

/**
 * Externals resolved from the frozen module table (platform modules). This list
 * MUST mirror the shell's `PLATFORM_MODULES`
 * (`packages/client/web/src/platform.ts`): those words are the only entities
 * the shell shares as instances, so bundling one instead of requiring it would
 * duplicate that module's identity — for `dsh-client-store` that means a second
 * store engine behind a seat read through the first one.
 */
const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Node-half externals: every peer/dsh dependency resolves at runtime. */
const NODE_EXTERNAL = (id: string): boolean => id.startsWith('@deepseek-ai/') || id === 'node:http'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '\0'

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

/** Rebase a lib-relative source onto a browser URL mirroring the repo dirs. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physical = resolve(dirname(sourcemapPath), source)
  const rel = relative(REPO_ROOT, physical).split(sep).join('/')
  return rel.startsWith('dsh-meter/') ? `../../../${rel}` : source
}

function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/** The node-half ESM library (from tsc-emitted JS). */
const nodeLib = {
  name: ID,
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  dts: false,
  clean: false,
  external: NODE_EXTERNAL,
  outputOptions: { entryFileNames: '[name].js' },
}

/** The browser client bundle (from src/client/index.ts). */
const client = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs' as const,
  platform: 'browser' as const,
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => (PLATFORM.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const tagId = `${ID}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapPathTransform: browserSourcePath,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [nodeLib, client]
