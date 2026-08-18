/**
 * Billing settings page: edit the price table grouped by the live registered
 * providers (from the host catalog). Each provider has its own currency and
 * a collapsible list of its models; each model row edits base (off-peak)
 * prices and optional peak windows. No manual model entry — models come from
 * the catalog. Reads and writes ride the fenced /billing/api routes.
 *
 * Prices are stored host-side as PRICE_PRECISION integers but EDITED as
 * "元/M" decimals (type `10.155`, not `1015500`). The price input keeps a
 * draft string and commits on blur/Enter, so clearing a `0` to type a new
 * number works (an empty field never snaps back to 0 mid-edit).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  getPriceTable, getProviderCatalog, updatePriceTable, notifyPricingUpdated,
  type ModelPrice, type PeakPeriod, type PriceTable, type PriceTier, type ProviderCatalogRow, type ModelCapability,
} from './billing-api.ts'
import { parsePriceInput, priceToInput, parseKTokensInput, kTokensToInput, formatTokens } from './format.ts'
import { consumeLocateModel, LOCATE_EVENT, type LocateModelRequest } from './locate.ts'
import { BillingLabel } from './BillingLabel.tsx'
import { type BillingKey } from './locales.ts'
import './theme.module.css'
import css from './BillingSettings.module.css'

/** The inject face apply passes to this section. */
export interface BillingSettingsInjected {
  t: (key: BillingKey) => string
}

/** Full props for the billing settings section. */
export type BillingSettingsSectionProps =
  BillingSettingsInjected & { close: () => void }

/** Per-provider editor state. */
interface ProviderEdit {
  id: string
  name: string
  currency: 'CNY' | 'USD'
  currencySymbol: string
  models: ModelEdit[]
}

/** Per-model editor state (keyed by provider/model). */
interface ModelEdit {
  provider: string
  model: string
  input: number
  output: number
  cacheInput: number
  cacheWrite: number
  periods: PeakPeriod[]
  tiers: PriceTier[]
  /** Whether tiered pricing is enabled (switch state); tiers persist only when on. */
  tierEnabled: boolean
  /** Real model capability (context window / output cap), when resolved. */
  capability?: ModelCapability
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; providers: ProviderEdit[] }
  | { status: 'error'; message: string }

/** Copy a peak period (immutable edits). */
function clonePeriod(p: PeakPeriod): PeakPeriod {
  return { ...p, ...(p.days !== undefined ? { days: [...p.days] } : {}), ...(p.tiers !== undefined ? { tiers: p.tiers.map(cloneTier) } : {}) }
}

/** Copy a price tier (immutable edits). */
function cloneTier(t: PriceTier): PriceTier {
  return { ...t }
}

/** A fresh tier seeded from a block's flat prices (ranges left undefined). */
function seedTier(input: number, output: number, cacheInput: number, cacheWrite: number): PriceTier {
  return { input, output, cacheInput, cacheWrite }
}

/** Build the editor rows: catalog providers × their models, seeded with prices. */
function buildEditor(catalog: ProviderCatalogRow[], table: PriceTable): ProviderEdit[] {
  // Seed ONLY from effort-less rows: the editor cannot represent
  // reasoningEffort-keyed rows (they are preserved on save), and seeding
  // from an effort row would duplicate it into a new effort-less row on
  // save, splitting the config. A model with only effort rows shows empty
  // (未登记) here — its effort rows still bill and survive saves.
  const byKey = new Map<string, ModelPrice>()
  for (const m of table.models) {
    if (m.reasoningEffort !== undefined) continue
    byKey.set(`${m.provider}/${m.model}`, m)
  }
  return catalog.map(provider => {
    const providerCurrency = table.providers[provider.id] ?? { currency: 'CNY' as const, currencySymbol: '¥' }
    return {
      id: provider.id,
      name: provider.name,
      currency: providerCurrency.currency,
      currencySymbol: providerCurrency.currencySymbol,
      models: provider.models.map(catModel => {
        const existing = byKey.get(`${provider.id}/${catModel.id}`)
        const existingTiers = existing?.tiers ?? []
        return {
          provider: provider.id,
          model: catModel.id,
          input: existing?.input ?? 0,
          output: existing?.output ?? 0,
          cacheInput: existing?.cacheInput ?? 0,
          cacheWrite: existing?.cacheWrite ?? 0,
          periods: (existing?.periods ?? []).map(clonePeriod),
          tiers: existingTiers.map(cloneTier),
          tierEnabled: existingTiers.length > 0,
          capability: catModel.capability,
        }
      }),
    }
  })
}

/** The nearest scrollable ancestor of a settings row (the panel content column). */
function scrollContainerOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node !== null) {
    const style = getComputedStyle(node)
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay')
      && node.scrollHeight > node.clientHeight
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * Scroll a model row into view: put it at the top of the scroll viewport
 * when the content below it fills the viewport, otherwise leave it near the
 * bottom — never scroll past the content end, so no blank space is forced.
 */
function scrollModelIntoView(row: HTMLElement): void {
  const container = scrollContainerOf(row)
  if (container === null) {
    row.scrollIntoView({ block: 'nearest' })
    return
  }
  const cRect = container.getBoundingClientRect()
  const rRect = row.getBoundingClientRect()
  const rowTop = rRect.top - cRect.top + container.scrollTop
  const below = container.scrollHeight - (rowTop + row.offsetHeight)
  const viewport = container.clientHeight
  const target = below >= viewport - row.offsetHeight
    ? rowTop
    : container.scrollHeight - container.clientHeight
  container.scrollTo({ top: target, behavior: 'smooth' })
}

/** The billing settings section. */
export function BillingSettingsSection({ t }: BillingSettingsSectionProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear the "saved" flash timer on unmount (no setState after unmount).
  useEffect(() => () => {
    if (flashTimer.current !== null) clearTimeout(flashTimer.current)
  }, [])
  // All provider groups start collapsed; the first successful load seeds the
  // collapsed set with every provider id (ids are only known after the load).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const defaultCollapsed = useRef(false)

  // A pending "locate this model" request from the header card: consumed on
  // mount (queued before the panel opened) or live via the window event
  // (section already mounted when the user clicks the gear again). The
  // functional update keeps the request across StrictMode's double effect.
  const [locate, setLocate] = useState<LocateModelRequest | undefined>(undefined)

  useEffect(() => {
    setLocate(previous => previous ?? consumeLocateModel())
  }, [])

  useEffect(() => {
    const onLocate = (event: Event): void => {
      consumeLocateModel()
      setLocate((event as CustomEvent<LocateModelRequest>).detail)
    }
    window.addEventListener(LOCATE_EVENT, onLocate)
    return () => window.removeEventListener(LOCATE_EVENT, onLocate)
  }, [])

  // Expand the located provider's group (groups start collapsed by default).
  useEffect(() => {
    if (locate === undefined || state.status !== 'ready') return
    if (collapsed.has(locate.provider)) {
      setCollapsed(prev => {
        const next = new Set(prev)
        next.delete(locate.provider)
        return next
      })
    }
  }, [locate, state, collapsed])

  // Scroll the located model row into view once it has rendered, then clear.
  useEffect(() => {
    if (locate === undefined || state.status !== 'ready') return
    const row = document.querySelector<HTMLElement>(
      `[data-billing-model="${CSS.escape(`${locate.provider}/${locate.model}`)}"]`,
    )
    if (row === null) return // provider still collapsed, or model not in the catalog
    scrollModelIntoView(row)
    setLocate(undefined)
  }, [locate, state, collapsed])

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const [catalog, table] = await Promise.all([getProviderCatalog(), getPriceTable()])
      const providers = buildEditor(catalog.providers, table)
      setState({ status: 'ready', providers })
      if (!defaultCollapsed.current) {
        defaultCollapsed.current = true
        setCollapsed(new Set(providers.map(p => p.id)))
      }
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const patchProvider = useCallback((providerId: string, fn: (p: ProviderEdit) => ProviderEdit) => {
    setState(s => {
      if (s.status !== 'ready') return s
      return { ...s, providers: s.providers.map(p => (p.id === providerId ? fn(p) : p)) }
    })
  }, [])

  const save = async (): Promise<void> => {
    if (state.status !== 'ready' || saving) return
    setSaving(true)
    setSaveError(undefined)
    try {
      const providers: PriceTable['providers'] = {}
      const models: ModelPrice[] = []
      // provider/model keys the editor represents (catalog-covered,
      // effort-less). The editor OWNS these rows: clearing one unregisters it.
      const editorKeys = new Set<string>()
      for (const provider of state.providers) {
        providers[provider.id] = { currency: provider.currency, currencySymbol: provider.currencySymbol }
        for (const m of provider.models) {
          editorKeys.add(`${m.provider}/${m.model}`)
          // Register a model only when it carries a price, a peak window, or a
          // price tier; untouched catalog models stay unregistered (→ 未登记价格).
          const hasBase = m.input !== 0 || m.output !== 0 || m.cacheInput !== 0 || m.cacheWrite !== 0
          // The default tier (index 0) carries the flat prices with its
          // user-editable range; extra tiers carry their own prices. When
          // tiering is off, no tiers persist and the flat prices stand alone.
          let saveTiers: PriceTier[]
          if (m.tierEnabled) {
            const defaultTier = m.tiers[0] ?? {}
            saveTiers = [
              { ...defaultTier, input: m.input, output: m.output, cacheInput: m.cacheInput, cacheWrite: m.cacheWrite },
              ...m.tiers.slice(1).map(cloneTier),
            ]
          } else {
            saveTiers = []
          }
          if (hasBase || m.periods.length > 0 || saveTiers.length > 0) {
            models.push({
              provider: m.provider,
              model: m.model,
              input: m.input,
              output: m.output,
              cacheInput: m.cacheInput,
              ...(m.cacheWrite !== 0 ? { cacheWrite: m.cacheWrite } : {}),
              periods: m.periods.map(clonePeriod),
              ...(saveTiers.length > 0 ? { tiers: saveTiers } : {}),
            })
          }
        }
      }
      // Merge back rows the editor cannot represent — models absent from the
      // live catalog (provider unlisted/offline) and reasoningEffort-keyed
      // rows. Without this, one save would silently delete them.
      const latest = await getPriceTable()
      for (const row of latest.models) {
        if (row.reasoningEffort !== undefined || !editorKeys.has(`${row.provider}/${row.model}`)) {
          models.push(row)
        }
      }
      for (const [id, currency] of Object.entries(latest.providers)) {
        if (!(id in providers) && models.some(m => m.provider === id)) providers[id] = currency
      }
      await updatePriceTable({ providers, models })
      // Tell mounted header actions to refetch the table — a save can change
      // peak window hours without changing their peak-model set.
      notifyPricingUpdated()
      setSavedFlash(true)
      if (flashTimer.current !== null) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setSavedFlash(false), 1500)
    } catch (error) {
      // Surface the failure next to the save button (the load-time error pane
      // is not mounted here, so a swallowed error would look like a hang).
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const toggle = (id: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (state.status === 'loading') {
    return <div className={css.pane}>{t('settings.loading')}</div>
  }
  if (state.status === 'error') {
    return <div className={css.pane}><span className={css.error}>{t('settings.error')}: {state.message}</span></div>
  }

  return (
    <div className={css.pane}>
      <div className={css.head}>
        <h2 className={css.title}>{t('settings.title')}</h2>
        <div className={css.headRight}>
          {saveError !== undefined ? <span className={css.error}>{t('settings.saveFailed')}: {saveError}</span> : null}
          {savedFlash ? <span className={css.saved}>{t('settings.saved')}</span> : null}
          <button type="button" className={css.save} onClick={() => void save()} disabled={saving}>
            {saving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>

      {state.providers.length === 0
        ? <div className={css.empty}>{t('settings.empty')}</div>
        : state.providers.map(provider => (
          <ProviderGroup
            key={provider.id}
            provider={provider}
            collapsed={collapsed.has(provider.id)}
            t={t}
            onToggle={() => toggle(provider.id)}
            onCurrency={(currency) => {
              patchProvider(provider.id, p => ({
                ...p,
                currency,
                currencySymbol: currency === 'CNY' ? '¥' : '$',
              }))
            }}
            onModel={(modelKey, fn) => {
              patchProvider(provider.id, p => ({
                ...p,
                models: p.models.map(m => (m.model === modelKey ? fn(m) : m)),
              }))
            }}
          />
        ))}
    </div>
  )
}

/** One collapsible provider group with its models. */
function ProviderGroup({ provider, collapsed, t, onToggle, onCurrency, onModel }: {
  provider: ProviderEdit
  collapsed: boolean
  t: (key: BillingKey) => string
  onToggle: () => void
  onCurrency: (currency: 'CNY' | 'USD') => void
  onModel: (model: string, fn: (m: ModelEdit) => ModelEdit) => void
}) {
  return (
    <div className={css.group}>
      <div className={css.groupHead}>
        <button type="button" className={css.groupTitle} onClick={onToggle}
          aria-expanded={!collapsed} aria-label={collapsed ? t('settings.expand') : t('settings.collapse')}>
          <span className={css.groupName}>{provider.name} <span className={css.groupId}>({provider.id})</span></span>
          <IconChevronDownOutline14 className={collapsed ? css.chevron : `${css.chevron} ${css.chevronOpen}`} />
        </button>
        <div className={css.providerMeta}>
          <label className={css.currencySelect}>
            <span className={css.miniLabel}>{t('settings.currency.label')}</span>
            <select
              className={css.select}
              value={provider.currency}
              onChange={e => onCurrency(e.target.value as 'CNY' | 'USD')}
            >
              <option value="CNY">CNY (¥)</option>
              <option value="USD">USD ($)</option>
            </select>
          </label>
          <span className={css.unitHint}>
            {t('settings.unit.label')}{provider.currencySymbol}/{t('settings.unit.million')}
          </span>
        </div>
      </div>
      {!collapsed && (
        <div className={css.models}>
          {provider.models.length === 0
            ? <div className={css.modelEmpty}>{t('settings.empty')}</div>
            : provider.models.map(model => (
              <ModelRow key={model.model} model={model} t={t}
                onChange={(fn) => onModel(model.model, fn)} />
            ))}
        </div>
      )}
    </div>
  )
}

/**
 * A decimal price input editing "元/M" values. Keeps a draft string so
 * clearing the field to type a new number works (no mid-edit coercion to
 * 0); commits to PRICE_PRECISION integer units on blur or Enter. Invalid or
 * empty input on commit reverts to the previous value. An unmount (group
 * collapse, tier-switch flip) commits the pending draft instead of losing it.
 */
function PriceInput({ value, onChange, ariaLabel }: {
  value: number
  onChange: (next: number) => void
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(() => priceToInput(value))
  const [focused, setFocused] = useState(false)
  const latest = useRef({ draft, value, onChange })
  latest.current = { draft, value, onChange }

  // External value changes (e.g. a new period prefilled from base) sync the
  // draft while the field is not being edited.
  useEffect(() => {
    if (!focused) setDraft(priceToInput(value))
  }, [value, focused])

  // Commit the pending draft on unmount (collapse/switch with the field
  // focused would otherwise drop it silently).
  useEffect(() => () => {
    const { draft: d, value: v, onChange: oc } = latest.current
    const next = parsePriceInput(d, v)
    if (next !== v) oc(next)
  }, [])

  const commit = (): void => {
    const next = parsePriceInput(draft, value)
    setDraft(priceToInput(next))
    if (next !== value) onChange(next)
  }

  return (
    <input
      className={css.input}
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
    />
  )
}

/**
 * An hour-of-day field shown as clock time (`9:00`, `23:00`; an end may be
 * `24:00` for a window closing at midnight). Commits only the hour — the
 * minutes are always :00; empty/invalid input reverts to the previous hour.
 */
function HourInput({ value, min = 0, max, onChange, ariaLabel }: {
  value: number
  /** Clamp lower bound; the schema requires endHour ≥ 1, so ends pass 1. */
  min?: number
  max: number
  onChange: (next: number) => void
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(() => `${value}:00`)
  const [focused, setFocused] = useState(false)
  const latest = useRef({ draft, value, onChange, min })
  latest.current = { draft, value, onChange, min }

  useEffect(() => {
    if (!focused) setDraft(`${value}:00`)
  }, [value, focused])

  // Commit the pending draft on unmount (see PriceInput).
  useEffect(() => () => {
    const { draft: d, value: v, onChange: oc, min: lo } = latest.current
    const parsed = Number.parseInt(d, 10)
    const next = Number.isNaN(parsed) ? v : Math.min(Math.max(parsed, lo), max)
    if (next !== v) oc(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- max is a stable prop
  }, [])

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    const next = Number.isNaN(parsed) ? value : Math.min(Math.max(parsed, min), max)
    setDraft(`${next}:00`)
    if (next !== value) onChange(next)
  }

  return (
    <input
      className={css.input}
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
    />
  )
}

/**
 * A K-token length field for the tier editor. Empty = unbounded (renders the
 * empty string, commits to `undefined`); invalid/negative input reverts.
 */
function LengthInput({ value, onChange, ariaLabel, placeholder }: {
  value: number | undefined
  onChange: (next: number | undefined) => void
  ariaLabel?: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(() => kTokensToInput(value))
  const [focused, setFocused] = useState(false)
  const latest = useRef({ draft, value, onChange })
  latest.current = { draft, value, onChange }

  useEffect(() => {
    if (!focused) setDraft(kTokensToInput(value))
  }, [value, focused])

  // Commit the pending draft on unmount (see PriceInput); invalid input is
  // dropped (reverts), matching the blur-commit behavior.
  useEffect(() => () => {
    const { draft: d, value: v, onChange: oc } = latest.current
    const next = parseKTokensInput(d)
    if (next !== null && next !== v) oc(next)
  }, [])

  const commit = (): void => {
    const next = parseKTokensInput(draft)
    if (next === null) {
      // Invalid input: revert to the previous value.
      setDraft(kTokensToInput(value))
      return
    }
    setDraft(kTokensToInput(next))
    if (next !== value) onChange(next)
  }

  return (
    <input
      className={css.input}
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur() } }}
    />
  )
}

/** One model's price row with base prices + peak windows + price tiers. */
function ModelRow({ model, t, onChange }: {
  model: ModelEdit
  t: (key: BillingKey) => string
  onChange: (fn: (m: ModelEdit) => ModelEdit) => void
}) {
  const setBase = (key: 'input' | 'output' | 'cacheInput' | 'cacheWrite', v: number): void => {
    onChange(m => ({ ...m, [key]: v }))
  }
  const addPeriod = (): void => {
    onChange(m => ({
      ...m,
      periods: [...m.periods, {
        startHour: 22,
        endHour: 6,
        input: m.input,
        output: m.output,
        cacheInput: m.cacheInput,
        cacheWrite: m.cacheWrite,
        // One peak price entry per base tier, aligned by index.
        tiers: m.tiers.map(t => seedTier(m.input, m.output, m.cacheInput, m.cacheWrite)),
      }],
    }))
  }
  const setPeriod = (index: number, fn: (p: PeakPeriod) => PeakPeriod): void => {
    onChange(m => ({ ...m, periods: m.periods.map((p, i) => (i === index ? fn(clonePeriod(p)) : p)) }))
  }
  const removePeriod = (index: number): void => {
    onChange(m => ({ ...m, periods: m.periods.filter((_, i) => i !== index) }))
  }
  const toggleTiers = (): void => {
    onChange(m => {
      const on = !m.tierEnabled
      return {
        ...m,
        tierEnabled: on,
        // On: seed the default tier (index 0, all-lengths, base prices) and
        // re-align each peak period with one price slot per base tier.
        // Off: clear all tiers; the base prices remain as flat pricing and
        // peak periods fall back to their own flat prices.
        tiers: on ? (m.tiers.length > 0 ? m.tiers : [seedTier(m.input, m.output, m.cacheInput, m.cacheWrite)]) : [],
        periods: on
          ? m.periods.map(p => ({
            ...p,
            tiers: (p.tiers ?? []).length > 0
              ? p.tiers
              : [seedTier(p.input, p.output, p.cacheInput, p.cacheWrite ?? 0)],
          }))
          : m.periods.map(p => ({ ...p, tiers: [] })),
      }
    })
  }
  const addTier = (): void => {
    onChange(m => {
      const next = [...m.tiers, seedTier(m.input, m.output, m.cacheInput, m.cacheWrite)]
      return {
        ...m,
        tiers: next,
        // Every peak period gains a matching price slot for the new tier.
        periods: m.periods.map(p => ({
          ...p,
          tiers: [...(p.tiers ?? []), seedTier(p.input, p.output, p.cacheInput, p.cacheWrite ?? 0)],
        })),
      }
    })
  }
  const setTier = (index: number, fn: (t: PriceTier) => PriceTier): void => {
    onChange(m => ({ ...m, tiers: m.tiers.map((tier, i) => (i === index ? fn(cloneTier(tier)) : tier)) }))
  }
  const removeTier = (index: number): void => {
    onChange(m => {
      const next = m.tiers.filter((_, i) => i !== index)
      return {
        ...m,
        tiers: next,
        // Every peak period drops the matching price slot.
        periods: m.periods.map(p => ({
          ...p,
          tiers: (p.tiers ?? []).filter((_, i) => i !== index),
        })),
      }
    })
  }

  // The default tier (index 0) edits the model's flat prices directly; extra
  // tiers carry their own prices. When tiering is off only the flat row shows.
  const tierRows = model.tierEnabled ? model.tiers : []

  return (
    <div className={css.row} data-billing-model={`${model.provider}/${model.model}`}>
      <div className={css.rowTitle}>
        <div className={css.modelTitle}>
          <span className={css.modelName}>{model.model}</span>
          {model.capability !== undefined && (model.capability.contextWindow !== undefined || model.capability.maxTokens !== undefined) ? (
            <span className={css.modelCap}>
              {model.capability.contextWindow !== undefined
                ? `${t('capability.context')} ${formatTokens(model.capability.contextWindow)}`
                : ''}
              {model.capability.contextWindow !== undefined && model.capability.maxTokens !== undefined
                ? ' · '
                : ''}
              {model.capability.maxTokens !== undefined
                ? `${t('capability.output')} ${formatTokens(model.capability.maxTokens)}${t('capability.configured')}`
                : ''}
            </span>
          ) : null}
        </div>
        <label className={css.tierSwitch}>
          <input
            type="checkbox"
            className={css.tierSwitchInput}
            checked={model.tierEnabled}
            onChange={toggleTiers}
            aria-label={t('settings.tier.label')}
          />
          <span className={css.tierSwitchTrack} aria-hidden="true">
            <span className={css.tierSwitchThumb} />
          </span>
          <span className={css.tierSwitchLabel}>{t('settings.tier.label')}</span>
        </label>
      </div>

      {/* Default price row = tier 0. Its range is editable when tiering is on;
          its prices always edit the model's flat fields. When tiering is off
          the fields render plain (no row box). */}
      {model.tierEnabled ? (
        <div className={css.tierBox}>
          <TierRangeLine
            tier={tierRows[0]}
            index={1}
            editable
            t={t}
            onBound={(key, v) => onChange(m => ({
              ...m,
              tiers: m.tiers.map((t, i) => (i === 0 ? withBound(t, key, v) : t)),
            }))}
          />
          <PriceFields t={t} prices={{ input: model.input, output: model.output, cacheInput: model.cacheInput, cacheWrite: model.cacheWrite }}
            onChange={(key, v) => setBase(key, v)} />
        </div>
      ) : (
        <PriceFields t={t} prices={{ input: model.input, output: model.output, cacheInput: model.cacheInput, cacheWrite: model.cacheWrite }}
          onChange={(key, v) => setBase(key, v)} />
      )}

      {model.tierEnabled ? (
        <div className={css.extraTiers}>
          {tierRows.slice(1).map((tier, i) => (
            <TierRow key={i} tier={tier} index={i + 2} t={t}
              onChange={(fn) => setTier(i + 1, fn)}
              onRemove={() => removeTier(i + 1)} />
          ))}
          <div className={css.addTierRow}>
            <button type="button" className={css.addPeriod} onClick={addTier}>
              {t('settings.tier.add')}
            </button>
          </div>
        </div>
      ) : null}

      <div className={css.peakBlock}>
        <div className={css.peakHead}>
          <span className={css.peakLabel}>{t('settings.peak.label')}</span>
          <button type="button" className={css.addPeriod} onClick={addPeriod}>
            {t('settings.peak.add')}
          </button>
        </div>
        {model.periods.map((period, i) => (
          <PeriodEditor key={i} period={period} modelTiers={tierRows} t={t}
            onChange={(fn) => setPeriod(i, fn)}
            onRemove={() => removePeriod(i)} />
        ))}
      </div>
    </div>
  )
}

/** One peak/off-peak window editor: window hours on top, then the per-tier
 *  peak prices inside a 分段计费 block. 区间 1 is the period's flat default
 *  and lives INSIDE the block (aligned with the base tiers), so the peak
 *  structure mirrors the idle tier editor: 时段 → 分段计费 → 区间 N rows. */
function PeriodEditor({ period, modelTiers, t, onChange, onRemove }: {
  period: PeakPeriod
  modelTiers: PriceTier[]
  t: (key: BillingKey) => string
  onChange: (fn: (p: PeakPeriod) => PeakPeriod) => void
  onRemove: () => void
}) {
  const setTier = (i: number, fn: (t: PriceTier) => PriceTier): void => {
    onChange(p => ({ ...p, tiers: (p.tiers ?? []).map((tier, j) => (j === i ? fn(cloneTier(tier)) : tier)) }))
  }
  // 区间 1 edits period.tiers[0] (the default tier) and mirrors the period's
  // flat prices so host pricing (which reads period.tiers by index) matches
  // what the user sees.
  const tierZero = (period.tiers ?? [])[0]
  const setTierZero = (key: 'input' | 'output' | 'cacheInput' | 'cacheWrite', v: number): void => {
    onChange(p => ({
      ...p,
      [key]: v,
      tiers: p.tiers !== undefined && p.tiers.length > 0
        ? p.tiers.map((tier, j) => (j === 0 ? { ...tier, [key]: v } : tier))
        // Legacy periods without tiers: seed tier 0 WITH this edit applied —
        // seeding from the pre-edit flat prices would swallow the first edit
        // (the display prefers tier 0 over the flat fields).
        : [{ ...seedTier(p.input, p.output, p.cacheInput, p.cacheWrite ?? 0), [key]: v }],
    }))
  }

  return (
    <div className={css.period}>
      <div className={css.periodHead}>
        <label className={css.miniLabel}>{t('settings.peak.start')}
          <HourInput value={period.startHour} max={23}
            onChange={v => onChange(p => ({ ...p, startHour: v }))} ariaLabel={t('settings.peak.start')} />
        </label>
        <label className={css.miniLabel}>{t('settings.peak.end')}
          <HourInput value={period.endHour} min={1} max={24}
            onChange={v => onChange(p => ({ ...p, endHour: v }))} ariaLabel={t('settings.peak.end')} />
        </label>
        <button type="button" className={css.removePeriod} onClick={onRemove} aria-label={t('settings.peak.remove')}>×</button>
      </div>

      {modelTiers.length > 0 ? (
        <div className={css.periodTiers}>
          <div className={css.peakHead}>
            <span className={css.peakLabel}>{t('settings.tier.label')}</span>
          </div>
          {/* 区间 1: the period's flat default. Ranges are read-only (reuse
              the base tier), prices edit period.tiers[0] and mirror the flat
              fields. */}
          <div className={css.tierBox}>
            <TierRangeLine tier={modelTiers[0]} index={1} editable={false} t={t} />
            <PriceFields t={t} prices={{
              input: tierZero?.input ?? period.input,
              output: tierZero?.output ?? period.output,
              cacheInput: tierZero?.cacheInput ?? period.cacheInput,
              cacheWrite: tierZero?.cacheWrite ?? period.cacheWrite ?? 0,
            }} onChange={(key, v) => setTierZero(key, v)} />
          </div>
          {/* Extra tiers (区间 2+): their own peak prices, aligned by index
              with the base tier ranges. Same tierBox layout as 区间 1. */}
          {(period.tiers ?? []).slice(1).map((tier, i) => (
            <div key={i} className={css.tierBox}>
              <TierRangeLine tier={modelTiers[i + 1]} index={i + 2} editable={false} t={t} />
              <PriceFields t={t} prices={{
                input: tier.input,
                output: tier.output,
                cacheInput: tier.cacheInput,
                cacheWrite: tier.cacheWrite ?? 0,
              }} onChange={(key, v) => setTier(i + 1, x => ({ ...x, [key]: v }))} />
            </div>
          ))}
        </div>
      ) : (
        // No tiering: just the period's flat prices, matching the idle model
        // row's plain (untiered) display.
        <PriceFields t={t} prices={{
          input: period.input,
          output: period.output,
          cacheInput: period.cacheInput,
          cacheWrite: period.cacheWrite ?? 0,
        }} onChange={(key, v) => onChange(p => ({ ...p, [key]: v }))} />
      )}
    </div>
  )
}

/** Compact read-only range text in interval notation, K units, matching the
 *  model's own tier definitions (e.g. GLM-4.7): `[0, 32)` for a closed lower
 *  + open upper bound, `[0.2+)` for a lower bound with no upper, `<32)` for
 *  an upper bound with no lower (lower absent = 0). */
function tierRangeText(min: number | undefined, max: number | undefined): string {
  const fmt = (v: number): string => String(v / 1000)
  const minText = min === undefined ? '0' : fmt(min)
  if (max === undefined) return `[${minText}+)`
  return `[${minText}, ${fmt(max)})`
}

/** One tier length bound. */
type BoundKey = 'inputMin' | 'inputMax' | 'outputMin' | 'outputMax'

/** Set one tier bound; `undefined` (cleared field) removes the bound. */
function withBound(tier: PriceTier, key: BoundKey, value: number | undefined): PriceTier {
  if (value === undefined) {
    const { [key]: _removed, ...rest } = tier
    return rest
  }
  return { ...tier, [key]: value }
}

/** The four per-M price fields shared by every tier/period row: 输入
 *  (缓存命中/未命中)、缓存写入、输出. Values come from one source and
 *  edits go through one callback, so idle tiers, peak periods and their
 *  per-tier rows stay identical. */
function PriceFields({ t, prices, onChange }: {
  t: (key: BillingKey) => string
  prices: { input: number; output: number; cacheInput: number; cacheWrite: number }
  onChange: (key: 'input' | 'output' | 'cacheInput' | 'cacheWrite', v: number) => void
}) {
  return (
    <div className={css.priceGrid}>
      <label className={css.miniLabel}>
        <BillingLabel label={t('settings.price.input')} hint={t('settings.price.cacheHit')} />
        <PriceInput value={prices.cacheInput} onChange={v => onChange('cacheInput', v)} ariaLabel={`${t('settings.price.input')} ${t('settings.price.cacheHit')}`} />
      </label>
      <label className={css.miniLabel}>
        <BillingLabel label={t('settings.price.input')} hint={t('settings.price.cacheMiss')} />
        <PriceInput value={prices.input} onChange={v => onChange('input', v)} ariaLabel={`${t('settings.price.input')} ${t('settings.price.cacheMiss')}`} />
      </label>
      <label className={css.miniLabel}>
        <span className={css.priceLabel}>{t('settings.price.cacheWrite')}</span>
        <PriceInput value={prices.cacheWrite} onChange={v => onChange('cacheWrite', v)} ariaLabel={t('settings.price.cacheWrite')} />
      </label>
      <label className={css.miniLabel}>{t('settings.price.output')}
        <PriceInput value={prices.output} onChange={v => onChange('output', v)} ariaLabel={t('settings.price.output')} />
      </label>
    </div>
  )
}

/** A tier's length-range line: editable bounds for the model's own tiers,
 *  read-only summary for peak periods (which reuse the base ranges). The
 *  editable form labels each dimension 输入区间/输出区间 and shows min–max
 *  inputs with the K unit; the read-only (peak) form labels them
 *  输入长度/输出长度 and renders interval notation `[0, 32)`, hiding a
 *  dimension that has no bound. */
function TierRangeLine({ tier, index, editable, t, onBound, onRemove }: {
  tier: PriceTier | undefined
  index: number
  editable: boolean
  t: (key: BillingKey) => string
  onBound?: (key: BoundKey, value: number | undefined) => void
  onRemove?: () => void
}) {
  const boundLine = (dim: 'input' | 'output', min: number | undefined, max: number | undefined): ReactNode => {
    // Read-only peak rows: only show a dimension when it actually constrains
    // lengths (a tier like `输入 [32,200)` with no output bound shows just
    // the input line).
    if (!editable && min === undefined && max === undefined) return null
    const label = editable
      ? (dim === 'input' ? t('settings.tier.inputRange') : t('settings.tier.outputRange'))
      : (dim === 'input' ? t('settings.tier.inputLength') : t('settings.tier.outputLength'))
    const lengthLabel = dim === 'input' ? t('settings.tier.inputLength') : t('settings.tier.outputLength')
    return (
      <div className={css.boundLine}>
        <span className={css.rangeLabel}>{label}</span>
        {editable ? (
          <>
            <LengthInput value={min} placeholder="0"
              onChange={v => onBound?.(`${dim}Min` as BoundKey, v)}
              ariaLabel={`${lengthLabel} ${t('settings.tier.from')}`} />
            <span className={css.boundDash}>–</span>
            <LengthInput value={max} placeholder="∞"
              onChange={v => onBound?.(`${dim}Max` as BoundKey, v)}
              ariaLabel={`${lengthLabel} ${t('settings.tier.to')}`} />
            <span className={css.boundUnit}>{t('settings.tier.kTokens')}</span>
          </>
        ) : (
          <span className={css.boundText}>{tier === undefined ? '—' : tierRangeText(min, max)}</span>
        )}
      </div>
    )
  }
  const inputBound = tier?.inputMin !== undefined || tier?.inputMax !== undefined
  const outputBound = tier?.outputMin !== undefined || tier?.outputMax !== undefined
  return (
    <div className={css.tierRangeLine}>
      <span className={css.tierNo}>{t('settings.tier.range')} {index}</span>
      <div className={css.boundStack}>
        {!editable && !inputBound && !outputBound ? (
          // The all-lengths default tier (区间 1) has no bounds: show a
          // single 全部 line instead of two empty dimension lines.
          <div className={css.boundLine}>
            <span className={css.boundText}>{t('settings.tier.all')}</span>
          </div>
        ) : (
          <>
            {boundLine('input', tier?.inputMin, tier?.inputMax)}
            {boundLine('output', tier?.outputMin, tier?.outputMax)}
          </>
        )}
      </div>
      {onRemove !== undefined ? (
        <button type="button" className={css.removePeriod} onClick={onRemove} aria-label={t('settings.tier.remove')}>×</button>
      ) : null}
    </div>
  )
}

/** One extra price tier row: a compact range line + the SAME four price
 *  fields as the base row (no tier-prefixed labels, so nothing wraps). */
function TierRow({ tier, index, t, onChange, onRemove }: {
  tier: PriceTier
  index: number
  t: (key: BillingKey) => string
  onChange: (fn: (t: PriceTier) => PriceTier) => void
  onRemove: () => void
}) {
  return (
    <div className={css.tierBox}>
      <TierRangeLine tier={tier} index={index} editable t={t}
        onBound={(key, v) => onChange(x => withBound(x, key, v))}
        onRemove={onRemove} />
      <PriceFields t={t} prices={{ input: tier.input, output: tier.output, cacheInput: tier.cacheInput, cacheWrite: tier.cacheWrite ?? 0 }}
        onChange={(key, v) => onChange(x => ({ ...x, [key]: v }))} />
    </div>
  )
}
