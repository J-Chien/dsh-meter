#!/usr/bin/env node
/**
 * Validate a dsh-meter price file and print the prices it produces.
 *
 * This is the self-check `docs/CONFIGURING.md` tells a writer (agent or human)
 * to run before claiming success: it loads the file with the SAME loader the
 * plugin uses, so a file this script accepts is a file the plugin will apply —
 * and it prints the effective off-peak/peak rate per row at real instants, so a
 * transcription can be compared against the provider's page instead of trusted.
 *
 *   node scripts/check-prices.mjs [file] [--json] [--at <ISO instant>]
 *
 * With no file it checks the plugin's default path
 * (`$DSH_HOME/dsh-meter/prices.yaml`, else `~/.dsh/dsh-meter/prices.yaml`).
 * Exit codes: 0 ok · 1 the file has problems · 2 cannot run (not built / no file).
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const libPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')
if (!existsSync(libPath)) {
  console.error('check-prices: lib/index.js is missing — run `pnpm build` (or install the published package).')
  process.exit(2)
}
const meter = await import(libPath)

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const atIndex = argv.indexOf('--at')
const at = atIndex === -1 ? undefined : argv[atIndex + 1]
const file = argv.find(argument => !argument.startsWith('--') && argument !== at) ?? meter.resolvePriceFile(undefined)

if (at !== undefined && Number.isNaN(Date.parse(at))) {
  console.error(`check-prices: --at "${String(at)}" is not a parseable instant (e.g. 2026-09-01T10:00:00+08:00)`)
  process.exit(2)
}

// Probe instants in the provider's default clock (Asia/Shanghai, the same
// fallback the fold uses): the official rule is weekday 09–12 and 14–18.
function nextMonday() {
  const shanghai = new Date(Date.now() + 8 * 3600_000)
  const day = shanghai.getUTCDay()
  const ahead = ((8 - day) % 7) || 7
  return new Date(shanghai.getTime() + ahead * 86_400_000).toISOString().slice(0, 10)
}
const monday = nextMonday()
const probes = at !== undefined ? [at] : [
  `${monday}T10:00:00+08:00`, // inside the morning peak
  `${monday}T13:00:00+08:00`, // the gap between the two windows → off-peak
  `${monday}T15:00:00+08:00`, // inside the afternoon peak
  new Date(Date.parse(`${monday}T10:00:00+08:00`) + 5 * 86_400_000).toISOString().replace('Z', '+00:00'), // Saturday
]

const report = meter.loadPriceFile(file)
if (!report.present) {
  console.error(`check-prices: no price file at ${file}`)
  if (!json) console.error('  (that path is the default; pass a path to check another file)')
  process.exit(2)
}

if (json) {
  console.log(JSON.stringify({
    path: report.path, rows: report.rows, errors: report.errors, warnings: report.warnings,
    rows_detail: report.table === undefined ? [] : report.table.models.map(row => ({
      provider: row.provider,
      model: row.model,
      ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort }),
      at: Object.fromEntries(probes.map(probe => [probe, meter.effectivePrice(report.table, row.provider, row.model, row.reasoningEffort, Date.parse(probe))])),
    })),
  }, null, 2))
  process.exit(report.errors.length > 0 ? 1 : 0)
}

const perMillion = units => Number((units / meter.PRICE_PRECISION).toFixed(6))

console.log(`price file : ${report.path}`)
console.log(`model rows : ${report.rows}`)
for (const warning of report.warnings) console.log(`warning    : ${warning}`)
for (const error of report.errors) console.log(`ERROR      : ${error}`)

if (report.errors.length > 0) {
  console.log('\nrefused: the plugin ignores this file whole and keeps the built-in/explicit table.')
  process.exit(1)
}

console.log(`\neffective prices, 元 / million tokens (probes at ${probes[0].slice(0, 10)} +08:00):`)
const columns = at !== undefined ? [at] : ['Mon 10:00', 'Mon 13:00', 'Mon 15:00', 'Sat 10:00']
const width = Math.max(...report.table.models.map(row => `${row.provider}/${row.model}`.length), 20)
console.log(`${'model'.padEnd(width)}  ${columns.map(column => column.padStart(22)).join('  ')}`)
for (const row of report.table.models) {
  const cells = probes.map(probe => {
    const price = meter.effectivePrice(report.table, row.provider, row.model, row.reasoningEffort, Date.parse(probe))
    if (!price.found) return 'unpriced'
    return `${price.period === 'peak' ? '峰' : '闲'} ${perMillion(price.input)}/${perMillion(price.output)}/${perMillion(price.cacheInput)}`
  })
  console.log(`${`${row.provider}/${row.model}`.padEnd(width)}  ${cells.map(cell => cell.padStart(22)).join('  ')}`)
}
console.log('\ncolumns are 切换/输入/输出/缓存命中 (元 per M). Compare against the provider page.')
