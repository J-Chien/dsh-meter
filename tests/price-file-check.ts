/**
 * Price-file checks (the agent-writable config; docs/CONFIGURING.md).
 *
 * The file exists so a link or a screenshot can become prices without GUI
 * clicks, which means the failure modes are WRITER mistakes, not user mistakes:
 * a raw-unit paste (every cost ×100000), a whole patch entry pasted instead of
 * its `config:` body, a duplicated row, a typo'd provider. Each of those has a
 * case below, and each must be caught BEFORE a number reaches a bill.
 *
 * Run: node --disable-warning=ExperimentalWarning tests/price-file-check.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RATE_CEILING, loadPriceFile, mergeTables, parsePriceFile, resolvePriceFile } from '../src/host/price-file.ts'
import { PRICE_PRECISION } from '../src/host/price.ts'
import { DEFAULT_TABLE } from '../src/host/default-prices.ts'
import type { PriceTable } from '../src/shared.ts'

const units = (yuanPerMillion: number) => Math.round(yuanPerMillion * PRICE_PRECISION)

// --- 1. The worked example: DeepSeek's published table, as an agent would
//        transcribe it from api-docs.deepseek.com/zh-cn/quick_start/pricing. ---
const DEEPSEEK_FILE = `
# 元 / 百万 tokens —— 与价目页和设置页显示的同一个数字
providers:
  deepseek-official:
    currency: CNY
    currencySymbol: '¥'
    timezone: Asia/Shanghai
models:
  - provider: deepseek-official
    model: deepseek-flash
    input: 1
    output: 4
    cacheInput: 0.02
    periods:
      - startHour: 9
        endHour: 12
        days: [1, 2, 3, 4, 5]
        input: 2
        output: 8
        cacheInput: 0.04
      - startHour: 14
        endHour: 18
        days: [1, 2, 3, 4, 5]
        input: 2
        output: 8
        cacheInput: 0.04
  - provider: deepseek-official
    model: deepseek-v4-pro
    input: 4.5
    output: 13.5
    cacheInput: 0.15
`

{
  const report = parsePriceFile(DEEPSEEK_FILE, 'deepseek.yaml')
  assert.deepEqual(report.errors, [], 'the published table parses with no errors')
  assert.deepEqual(report.warnings, [], 'and with no warnings')
  assert.equal(report.rows, 2, 'both model rows are read')
  const table = report.table as PriceTable
  assert.equal(table.providers['deepseek-official']?.currency, 'CNY', 'provider currency survives')
  assert.equal(table.providers['deepseek-official']?.timezone, 'Asia/Shanghai', 'provider timezone survives')
  const flash = table.models.find(row => row.model === 'deepseek-flash')
  assert.equal(flash?.input, units(1), '1 元/M becomes 1 × PRICE_PRECISION units')
  assert.equal(flash?.cacheInput, units(0.02), '0.02 元/M keeps its precision (not rounded to 0)')
  assert.equal(flash?.periods?.length, 2, 'both peak windows survive')
  assert.deepEqual(flash?.periods?.[0]?.days, [1, 2, 3, 4, 5], 'the weekday mask survives')
  assert.equal(flash?.periods?.[1]?.input, units(2), 'the peak rate converts too')
  const pro = table.models.find(row => row.model === 'deepseek-v4-pro')
  assert.equal(pro?.output, units(13.5), 'a fractional rate converts without loss')
}

// --- 2. JSON is accepted (JSON is a YAML subset) — some writers emit it. ---
{
  const report = parsePriceFile(JSON.stringify({
    providers: { wpsai: { currency: 'CNY', currencySymbol: '¥' } },
    models: [{ provider: 'wpsai', model: 'x', input: 3, output: 6, cacheInput: 0 }],
  }))
  assert.deepEqual(report.errors, [], 'a JSON body parses')
  assert.equal(report.table?.models[0]?.input, units(3), 'and converts by the same rule')
}

// --- 3. THE expensive mistake: 1e-5 units pasted instead of per-million. ---
{
  const report = parsePriceFile(`
providers:
  wpsai: { currency: CNY, currencySymbol: '¥' }
models:
  - provider: wpsai
    model: deepseek/deepseek-v4-pro
    input: 300000
    output: 600000
    cacheInput: 2500
`)
  assert.equal(report.table, undefined, 'a raw-unit paste is refused, not converted')
  assert.equal(report.errors.length, 1, 'one error names the row (not one per field)')
  assert.match(report.errors[0] ?? '', /wpsai\/deepseek\/deepseek-v4-pro/, 'the message names the row')
  assert.match(report.errors[0] ?? '', /exceeds 100000\/M/, 'states the ceiling')
  assert.match(report.errors[0] ?? '', /per-MILLION tokens/, 'and how to fix it')
  // A row whose only over-ceiling field is a cheap sibling still fails as a row:
  // 0.025 元/M of cache-hit input is `2500` internally, far below any ceiling.
  const cheapSibling = parsePriceFile(`
providers:
  wpsai: { currency: CNY, currencySymbol: '¥' }
models:
  - provider: wpsai
    model: m
    input: 300000
    output: 600000
    cacheInput: 2500
`)
  assert.equal(cheapSibling.table, undefined, 'the whole row is refused, cheap fields included')
  // The guard covers period and tier rates, not just the row's own fields.
  const nested = parsePriceFile(`
providers:
  wpsai: { currency: CNY, currencySymbol: '¥' }
models:
  - provider: wpsai
    model: m
    input: 1
    output: 1
    cacheInput: 0
    periods:
      - startHour: 9
        endHour: 12
        input: 300000
        output: 1
        cacheInput: 0
`)
  assert.equal(nested.table, undefined, 'a raw-unit PERIOD rate is refused too')
  assert.match(nested.errors.join(' '), /periods\[0\]\.input/, 'and the message points at the field')
}

// --- 4. A whole patch entry pasted instead of its `config:` body. ---
{
  const asList = parsePriceFile(`
- id: billing
  name: dsh-meter
  config:
    providers: {}
    models: []
`)
  assert.equal(asList.table, undefined, 'an entry LIST is refused')
  assert.match(asList.errors[0] ?? '', /patch ENTRY LIST/, 'and the message says what to paste instead')

  const asEntry = parsePriceFile(`
id: billing
name: dsh-meter
config:
  providers: {}
  models: []
`)
  assert.equal(asEntry.table, undefined, 'an entry MAPPING is refused')
  assert.match(asEntry.errors[0] ?? '', /top-level `id`/, 'naming the offending key')
}

// --- 5. Structural mistakes. ---
{
  const missing = parsePriceFile('models:\n  - provider: p\n    model: m\n    input: 1\n    output: 2\n')
  assert.equal(missing.table, undefined, 'a row without cacheInput is refused')
  assert.match(missing.errors.join(' '), /cacheInput/, 'the schema names the missing field')

  const badHour = parsePriceFile(`
models:
  - provider: p
    model: m
    input: 1
    output: 2
    cacheInput: 0
    periods:
      - startHour: 99
        endHour: 12
        input: 1
        output: 2
        cacheInput: 0
`)
  assert.equal(badHour.table, undefined, 'an impossible hour is refused')
  assert.match(badHour.errors.join(' '), /startHour/, 'and named')

  const broken = parsePriceFile('models: [\n  {provider: p')
  assert.equal(broken.table, undefined, 'unparsable YAML is refused')
  assert.match(broken.errors[0] ?? '', /not valid YAML/, 'reported as a parse error')

  const empty = parsePriceFile('providers: {}\nmodels: []\n')
  assert.equal(empty.table, undefined, 'an empty file is refused')
  assert.match(empty.errors.join(' '), /no models/, 'because it would silently price nothing')
}

// --- 6. Duplicates and undeclared providers. ---
{
  const twice = parsePriceFile(`
models:
  - { provider: p, model: m, input: 1, output: 2, cacheInput: 0 }
  - { provider: p, model: m, input: 9, output: 9, cacheInput: 0 }
`)
  assert.equal(twice.table, undefined, 'a duplicated row is refused (order would decide the price)')
  assert.match(twice.errors.join(' '), /declared 2 times/, 'with the count')

  const undeclared = parsePriceFile(`
models:
  - { provider: brand-new, model: m, input: 1, output: 2, cacheInput: 0 }
`)
  assert.deepEqual(undeclared.errors, [], 'an undeclared provider is not fatal')
  assert.match(undeclared.warnings.join(' '), /assumed CNY ¥/, 'but it is reported')
  assert.equal(undeclared.table?.providers['brand-new']?.currencySymbol, '¥', 'and filled in so costs render')
}

// --- 7. Timezone typos would silently mis-price peak windows. ---
{
  const report = parsePriceFile(`
providers:
  p: { currency: CNY, currencySymbol: '¥', timezone: Asia/Shanghi }
models:
  - { provider: p, model: m, input: 1, output: 2, cacheInput: 0 }
`)
  assert.equal(report.table, undefined, 'a bad timezone is refused')
  assert.match(report.errors.join(' '), /not an IANA name/, 'explaining why')
}

// --- 8. Path resolution: default, DSH_HOME, ~, and relative. ---
{
  const env = { DSH_HOME: '/home/u/.dsh' }
  assert.equal(resolvePriceFile(undefined, env, '/home/u'), '/home/u/.dsh/dsh-meter/prices.yaml',
    'the default lives beside the rest of the harness state')
  assert.equal(resolvePriceFile(undefined, {}, '/home/u'), '/home/u/.dsh/dsh-meter/prices.yaml',
    'without DSH_HOME it falls back to ~/.dsh')
  assert.equal(resolvePriceFile('/etc/prices.yml', env, '/home/u'), '/etc/prices.yml', 'an absolute path is used as-is')
  assert.equal(resolvePriceFile('~/mine.yml', env, '/home/u'), '/home/u/mine.yml', '~ expands to the home directory')
  assert.equal(resolvePriceFile('team/prices.yml', env, '/home/u'), '/home/u/.dsh/team/prices.yml',
    'a relative path resolves against the harness home, not the process cwd')
  assert.equal(resolvePriceFile('   ', env, '/home/u'), '/home/u/.dsh/dsh-meter/prices.yaml', 'blank means default')
}

// --- 9. mergeTables: the file's rows replace, the rest survive in order. ---
{
  const base: PriceTable = {
    providers: { a: { currency: 'CNY', currencySymbol: '¥' }, b: { currency: 'USD', currencySymbol: '$' } },
    models: [
      { provider: 'a', model: 'one', input: 1, output: 1, cacheInput: 0 },
      { provider: 'a', model: 'two', input: 2, output: 2, cacheInput: 0 },
      { provider: 'b', model: 'three', input: 3, output: 3, cacheInput: 0 },
    ],
  }
  const overlay: PriceTable = {
    providers: { a: { currency: 'USD', currencySymbol: '$' }, c: { currency: 'CNY', currencySymbol: '¥' } },
    models: [
      { provider: 'a', model: 'two', input: 20, output: 20, cacheInput: 0 },
      { provider: 'c', model: 'four', input: 4, output: 4, cacheInput: 0 },
    ],
  }
  const merged = mergeTables(base, overlay)
  assert.equal(merged.models.length, 4, 'replaced rows do not duplicate, new rows are appended')
  assert.deepEqual(merged.models.map(row => `${row.provider}/${row.model}`),
    ['a/one', 'a/two', 'b/three', 'c/four'], 'untouched rows keep their order')
  assert.equal(merged.models[1]?.input, 20, 'the overlay row wins')
  assert.equal(merged.models[0]?.input, 1, 'an unmentioned row is untouched')
  assert.equal(merged.providers.a?.currency, 'USD', 'provider keys merge per key')
  assert.equal(merged.providers.b?.currency, 'USD', 'and an unmentioned provider survives')
  assert.equal(base.models[1]?.input, 2, 'the base table is not mutated')
}

// --- 10. loadPriceFile: a missing file is normal, an unreadable one is not. ---
{
  const dir = mkdtempSync(join(tmpdir(), 'dsh-meter-'))
  const absent = loadPriceFile(join(dir, 'nope.yaml'))
  assert.deepEqual([absent.present, absent.errors], [false, []], 'ENOENT is not an error')

  const unreadable = loadPriceFile(dir)
  assert.equal(unreadable.present, true, 'a directory reads as present…')
  assert.match(unreadable.errors.join(' '), /cannot read/, '…and reports why it failed')

  const good = join(dir, 'prices.yaml')
  writeFileSync(good, DEEPSEEK_FILE)
  const loaded = loadPriceFile(good)
  assert.equal(loaded.rows, 2, 'a real file on disk loads end to end')
  assert.equal(loaded.table?.models.length, 2, 'with its table')
}

// --- 11. The ceiling itself: a legal-but-huge reference price must pass. ---
{
  const report = parsePriceFile(`
models:
  - { provider: p, model: m, input: ${String(RATE_CEILING)}, output: 1, cacheInput: 0 }
`)
  assert.deepEqual(report.errors, [], 'a price exactly at the ceiling is a real price, not a unit mistake')
}

console.log('PRICE FILE CHECK PASSED')
