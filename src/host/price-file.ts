/**
 * The agent-writable price file.
 *
 * Why a file at all: the settings page is the right tool for a human clicking
 * through a table, and the wrong one for "here is the provider's price page (or
 * a screenshot) — make the meter price it". A file gives an agent exactly one
 * path to write, one format to get right, and one command to check itself with
 * (`scripts/check-prices.mjs`).
 *
 * FORMAT CONTRACT — `docs/CONFIGURING.md` is the normative copy; this module is
 * the enforcement:
 *  - YAML or JSON. The document body IS the price table — NOT a profile patch
 *    entry, and not wrapped in `config:`.
 *  - Prices are the provider's currency per MILLION tokens, i.e. exactly the
 *    numbers the provider's price page and the settings page show. The config
 *    layers store 1e-5 units internally; that is an implementation detail this
 *    format deliberately does not expose, and `RATE_CEILING` catches a paste in
 *    those units.
 *  - `providers` keys are the LLM route ids the harness reports.
 *
 * Loading NEVER throws. A malformed file must not take the session header down:
 * the caller gets diagnostics, keeps the built-in defaults, and logs. A file
 * with any error is dropped whole rather than half-applied — "some of the
 * prices are the file's" is worse than a loud failure.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { load as parseYaml } from 'js-yaml'
import { PRICE_PRECISION } from './price.ts'
import type { ModelPrice, PeakPeriod, PriceTable, PriceTier, ProviderCurrency } from '../shared.ts'

/**
 * Largest plausible per-million rate, in the provider's own currency. A value
 * above this is almost certainly a raw 1e-5-unit row copied out of
 * `cordis.patch.yml` (3 元/M is `300000` there), which would multiply every
 * cost by 100000 — the single worst mistake this format can invite.
 */
export const RATE_CEILING = 100_000

/** Structural validation of the file body, in the file's own units. */
const rateSchema = z.object({
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
})

const tierSchema = z.object({
  inputMin: z.number().min(0),
  inputMax: z.number().min(0),
  outputMin: z.number().min(0),
  outputMax: z.number().min(0),
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
})

const periodSchema = z.object({
  startHour: z.number().min(0).max(23).required(),
  endHour: z.number().min(1).max(24).required(),
  days: z.array(z.number().min(0).max(6)),
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
  tiers: z.array(tierSchema).default([]),
})

const modelSchema = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  input: z.number().min(0).required(),
  output: z.number().min(0).required(),
  cacheInput: z.number().min(0).required(),
  cacheWrite: z.number().min(0),
  periods: z.array(periodSchema).default([]),
  tiers: z.array(tierSchema).default([]),
})

const providerSchema = z.object({
  currency: z.union([z.const('CNY'), z.const('USD')]).default('CNY'),
  currencySymbol: z.string().default('¥'),
  timezone: z.string().max(64),
})

const fileSchema = z.object({
  providers: z.dict(providerSchema).default({}),
  models: z.array(modelSchema).default([]),
})

/** One model row as the FILE spells it (currency per million tokens). */
interface FileModelRow {
  provider: string
  model: string
  reasoningEffort?: string
  input: number
  output: number
  cacheInput: number
  cacheWrite?: number
  periods: FilePeriod[]
  tiers: FileTier[]
}

interface FilePeriod {
  startHour: number
  endHour: number
  days?: number[]
  input: number
  output: number
  cacheInput: number
  cacheWrite?: number
  tiers: FileTier[]
}

interface FileTier {
  inputMin?: number
  inputMax?: number
  outputMin?: number
  outputMax?: number
  input: number
  output: number
  cacheInput: number
  cacheWrite?: number
}

/** What a load attempt found; `errors` non-empty means nothing was applied. */
export interface PriceFileReport {
  /** Absolute path the loader read (or tried to read). */
  path: string
  /** False only for ENOENT — a missing file is normal, not a problem. */
  present: boolean
  /** The validated table in config units; absent when the file was unusable. */
  table?: PriceTable
  /** Model rows the file declares. */
  rows: number
  /** Fatal problems: the file is ignored whole. */
  errors: string[]
  /** Non-fatal notes worth logging. */
  warnings: string[]
}

/** `$DSH_HOME` (the harness home), falling back to `~/.dsh`. */
export function dshHome(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(home, '.dsh')
}

/**
 * The file this plugin reads: the configured path, else
 * `<dsh home>/dsh-meter/prices.yaml`. `~` expands to the user's home and a
 * relative path resolves against the harness home, so the default and a
 * hand-typed path mean the same thing.
 * @param configured - the entry config's `priceFile`, if any.
 * @param env - environment holding `DSH_HOME`.
 * @param home - the user's home directory.
 * @returns an absolute path.
 */
export function resolvePriceFile(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const raw = configured?.trim()
  if (raw === undefined || raw === '') return join(dshHome(env, home), 'dsh-meter', 'prices.yaml')
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return isAbsolute(raw) ? raw : resolve(dshHome(env, home), raw)
}

/** Per-million rate → the config's 1e-5 integer units. */
function toUnits(rate: number): number {
  return Math.round(rate * PRICE_PRECISION)
}

function convertTier(tier: FileTier): PriceTier {
  return {
    ...(tier.inputMin === undefined ? {} : { inputMin: tier.inputMin }),
    ...(tier.inputMax === undefined ? {} : { inputMax: tier.inputMax }),
    ...(tier.outputMin === undefined ? {} : { outputMin: tier.outputMin }),
    ...(tier.outputMax === undefined ? {} : { outputMax: tier.outputMax }),
    input: toUnits(tier.input),
    output: toUnits(tier.output),
    cacheInput: toUnits(tier.cacheInput),
    ...(tier.cacheWrite === undefined ? {} : { cacheWrite: toUnits(tier.cacheWrite) }),
  }
}

function convertPeriod(period: FilePeriod): PeakPeriod {
  return {
    startHour: period.startHour,
    endHour: period.endHour,
    ...(period.days === undefined ? {} : { days: [...period.days] }),
    input: toUnits(period.input),
    output: toUnits(period.output),
    cacheInput: toUnits(period.cacheInput),
    ...(period.cacheWrite === undefined ? {} : { cacheWrite: toUnits(period.cacheWrite) }),
    tiers: (period.tiers ?? []).map(convertTier),
  }
}

function convertRow(row: FileModelRow): ModelPrice {
  return {
    provider: row.provider,
    model: row.model,
    ...(row.reasoningEffort === undefined ? {} : { reasoningEffort: row.reasoningEffort }),
    input: toUnits(row.input),
    output: toUnits(row.output),
    cacheInput: toUnits(row.cacheInput),
    ...(row.cacheWrite === undefined ? {} : { cacheWrite: toUnits(row.cacheWrite) }),
    periods: (row.periods ?? []).map(convertPeriod),
    tiers: (row.tiers ?? []).map(convertTier),
  }
}

/** Every rate field of one row, with the path that names it in diagnostics. */
function ratesOf(prefix: string, source: Record<string, unknown>): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = []
  for (const field of ['input', 'output', 'cacheInput', 'cacheWrite']) {
    const value = source[field]
    if (typeof value === 'number') out.push({ label: prefix === '' ? field : `${prefix}.${field}`, value })
  }
  return out
}

/** A timezone name the fold can actually judge windows in. */
function isIanaTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/**
 * Parse and validate one price-file document.
 * @param text - the file's text (YAML or JSON).
 * @param path - the path, for diagnostics only.
 * @returns a report whose `table` is present only when nothing was wrong.
 */
export function parsePriceFile(text: string, path = '<price file>'): PriceFileReport {
  const errors: string[] = []
  const warnings: string[] = []

  let raw: unknown
  try {
    raw = parseYaml(text, { filename: path })
  } catch (error) {
    return { path, present: true, rows: 0, errors: [`${path} is not valid YAML/JSON: ${(error as Error).message}`], warnings }
  }

  // The two shapes an agent is most likely to paste instead of the body.
  if (Array.isArray(raw)) {
    return {
      path, present: true, rows: 0, warnings,
      errors: [`${path} is a patch ENTRY LIST; the file holds the price table itself (the value a patch entry would put under \`config:\`)`],
    }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { path, present: true, rows: 0, errors: [`${path} must be a mapping with \`providers\` and/or \`models\``], warnings }
  }
  const record = raw as Record<string, unknown>
  for (const key of ['id', 'name', 'config']) {
    if (Object.hasOwn(record, key)) {
      return {
        path, present: true, rows: 0, warnings,
        errors: [`${path} has a top-level \`${key}\` — that is a profile patch entry; this file holds the table itself`],
      }
    }
  }

  let parsed: { providers: Record<string, ProviderCurrency>; models: FileModelRow[] }
  try {
    parsed = fileSchema(record) as typeof parsed
  } catch (error) {
    return { path, present: true, rows: 0, errors: [`${path} does not match the price-file format: ${(error as Error).message}`], warnings }
  }

  const models = parsed.models
  const providers = { ...parsed.providers }

  if (models.length === 0) {
    errors.push(`${path} declares no models — an empty price file would silently price nothing`)
  }

  // Raw-unit paste guard, on the file's own numbers (before conversion).
  //
  // Judged PER ROW, not per field: a pasted row is wrong as a whole, and its
  // cheap fields (a 0.025 元/M cache-hit price is `2500` internally) sit under
  // any ceiling — flagging only the big fields would let a half-converted row
  // through. One error per row also keeps the report readable.
  for (const row of models) {
    const label = `${row.provider}/${row.model}`
    const rates = [
      ...ratesOf('', row as unknown as Record<string, unknown>),
      ...(row.periods ?? []).flatMap((period, index) => ratesOf(`periods[${index}]`, period as unknown as Record<string, unknown>)),
      ...(row.tiers ?? []).flatMap((tier, index) => ratesOf(`tiers[${index}]`, tier as unknown as Record<string, unknown>)),
    ]
    const offender = rates.find(rate => rate.value > RATE_CEILING)
    if (offender !== undefined) {
      errors.push(`${label} looks like internal 1e-5 units, not per-MILLION tokens:`
        + ` ${offender.label || 'input'} = ${String(offender.value)} exceeds ${String(RATE_CEILING)}/M`
        + ' — write the number the provider\u2019s page shows (3 元/M is `3`)')
    }
  }

  // Duplicate keys would make which row wins depend on document order.
  const seen = new Map<string, number>()
  for (const row of models) {
    const key = `${row.provider}\u0000${row.model}\u0000${row.reasoningEffort ?? ''}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const [provider, model] = key.split('\u0000')
      errors.push(`${provider}/${model} is declared ${count} times; keep one row per provider+model (+reasoningEffort)`)
    }
  }

  // A row whose provider is undeclared still prices, but renders without a
  // currency symbol — tell the writer instead of shipping a bare number.
  for (const row of models) {
    if (providers[row.provider] === undefined) {
      providers[row.provider] = { currency: 'CNY', currencySymbol: '¥' }
      warnings.push(`${row.provider} was not declared under \`providers\`; assumed CNY ¥`)
    }
  }

  for (const [id, provider] of Object.entries(providers)) {
    if (provider.timezone !== undefined && provider.timezone !== '' && !isIanaTimezone(provider.timezone)) {
      errors.push(`providers.${id}.timezone = "${provider.timezone}" is not an IANA name (e.g. Asia/Shanghai)`)
    }
  }

  if (errors.length > 0) return { path, present: true, rows: models.length, errors, warnings }

  return {
    path,
    present: true,
    rows: models.length,
    errors,
    warnings,
    table: { providers, models: models.map(convertRow) },
  }
}

/**
 * Read and validate the price file.
 * @param path - absolute path (see {@link resolvePriceFile}).
 * @returns a report; a missing file reports `present: false` and no errors.
 */
export function loadPriceFile(path: string): PriceFileReport {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path, present: false, rows: 0, errors: [], warnings: [] }
    return { path, present: true, rows: 0, errors: [`cannot read ${path}: ${(error as Error).message}`], warnings: [] }
  }
  return parsePriceFile(text, path)
}

/** Identity of one model row: provider + model + optional reasoning effort. */
function rowKey(row: { provider: string; model: string; reasoningEffort?: string }): string {
  return `${row.provider}\u0000${row.model}\u0000${row.reasoningEffort ?? ''}`
}

/**
 * Overlay one table on another. The overlay wins per provider key and per model
 * row (whole-row replacement — a half-merged row mixing two sources' fields
 * would be a price nobody wrote), and rows the overlay does not mention are
 * kept in their original order with the new rows appended.
 * @param base - the table being overridden (the entry config).
 * @param overlay - the table doing the overriding (the price file).
 * @returns a new table; neither input is mutated.
 */
export function mergeTables(base: PriceTable, overlay: PriceTable): PriceTable {
  const merged = new Map<string, ModelPrice>()
  for (const row of base.models) merged.set(rowKey(row), row)
  for (const row of overlay.models) merged.set(rowKey(row), row)
  return {
    providers: { ...base.providers, ...overlay.providers },
    models: [...merged.values()],
  }
}
