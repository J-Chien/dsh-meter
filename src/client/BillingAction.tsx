/**
 * Session-header billing action: a persistent entry (always visible) that
 * opens a billing card on hover or click. The card shows per-session token
 * buckets, cache hit rate, per-currency cost (with a 空闲/高峰 split when the
 * models configure peak periods), a refresh button, and a Settings button
 * that opens the Billing settings page.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronDownOutline14, IconRefreshOutline16, IconSettingsOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { CONTEXT_WARN_THRESHOLD, EMPTY_STATS, inPeakWindow, SINGLE_TURN_WARN_RATIO, aggregateTurns, type PriceTable, type SessionBillingStats, type TurnCost } from '../shared.ts'
import { formatPrice, formatTokens } from './format.ts'
import { getPriceTable, refreshSessionStats } from './billing-api.ts'
import { requestLocateModel } from './locate.ts'
import type {} from './types.ts'
import { BillingLabel } from './BillingLabel.tsx'
import { NS, type BillingKey } from './locales.ts'
import { BillingTurnsPanel } from './BillingTurnsPanel.tsx'
import css from './BillingAction.module.css'

/** The inject face apply passes to this component. */
export interface BillingActionInjected {
  t: (key: BillingKey) => string
}

/** Full props for the session-header billing action. */
export type BillingActionProps =
  PropsRuntime<'conversation.session.header.actions'> & BillingActionInjected

/**
 * Whether any peak window of the session's peak-configured models covers
 * `timeMs`. Peak keys are "provider/model"; provider ids contain no '/', so
 * the first slash splits them. Returns false until the price table arrives.
 */
function inPeakNow(peakModels: readonly string[], table: PriceTable | null, timeMs: number): boolean {
  if (table === null) return false
  // Callers tolerate frames from a host that has not restarted with the
  // peakModels field yet (its schema strips the unknown key) by passing [].
  for (const key of peakModels) {
    const slash = key.indexOf('/')
    if (slash <= 0) continue
    const provider = key.slice(0, slash)
    const model = key.slice(slash + 1)
    const row = table.models.find(m => m.provider === provider && m.model === model)
    if (row?.periods === undefined) continue
    if (row.periods.some(p => inPeakWindow(p, timeMs))) return true
  }
  return false
}

/** Symbol for a currency code. */
export function currencySymbol(code: string): string {
  return code === 'USD' ? '$' : '¥'
}

/**
 * The header action: a cost badge that opens a card on pointer rest or click.
 * The badge is always rendered; a session whose models have no registered
 * price shows 「未登记价格」, a fresh session shows ¥0.00.
 */
export function BillingAction({ sessionId, useProjection, t }: BillingActionProps) {
  const projected = useProjection('billing')
  const [override, setOverride] = useState<SessionBillingStats | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)
  const [peakNow, setPeakNow] = useState(false)
  const tableRef = useRef<PriceTable | null>(null)
  const [turnsOpen, setTurnsOpen] = useState(false)

  // A new projection frame supersedes any refresh override.
  useEffect(() => { setOverride(undefined) }, [projected])

  const stats = override ?? projected ?? EMPTY_STATS
  const peakModels = stats.peakModels ?? []
  const peakKey = peakModels.join('|')

  // Fetch the price table on mount and when the session's peak-model set
  // changes (a settings save re-mounts the projection, which can change it).
  // Token counters move with every message, so this must NOT depend on the
  // whole stats object — that would POST once per frame.
  useEffect(() => {
    let cancelled = false
    const evaluate = async (): Promise<void> => {
      try {
        const table = await getPriceTable()
        if (cancelled) return
        tableRef.current = table
        setPeakNow(inPeakNow(peakModels, table, Date.now()))
      } catch {
        // Transient failure: keep the previous table and tag state.
      }
    }
    void evaluate()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content
  }, [peakKey])

  // Re-evaluate against the clock every minute so the tag flips at window
  // boundaries without host round-trips.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (tableRef.current !== null) setPeakNow(inPeakNow(peakModels, tableRef.current, Date.now()))
    }, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content
  }, [peakKey])

  const doRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const [freshStats, table] = await Promise.all([refreshSessionStats(String(sessionId)), getPriceTable()])
      tableRef.current = table
      setPeakNow(inPeakNow(freshStats.peakModels ?? [], table, Date.now()))
      setOverride(freshStats)
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, sessionId])

  const badge = badgeText(stats, t)
  const hasPeakModels = peakModels.length > 0
  const unpriced = stats.requestCount === 0 && stats.unpricedRequestCount > 0

  const card = useMemo(() => (
    <BillingCard stats={stats} t={t} refreshing={refreshing}
      onRefresh={() => void doRefresh()}
      onDetail={() => setTurnsOpen(true)} />
  ), [stats, t, refreshing, doRefresh])

  return (
    <>
      <BillingPopover
        renderTrigger={open => (
          <button type="button" data-billing-trigger="" className={css.trigger} aria-label={t('trigger.aria')} aria-haspopup="dialog" aria-expanded={open}>
            <span className={unpriced ? css.unpricedTag : css.badge}>{badge}</span>
            {hasPeakModels ? (
              <span className={peakNow ? css.peakTag : css.offPeakTag}>
                {peakNow ? t('trigger.peak') : t('trigger.offPeak')}
              </span>
            ) : null}
            <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
          </button>
        )}
        content={card}
        t={t}
      />
      {turnsOpen ? (
        <BillingTurnsPanel sessionId={String(sessionId)} stats={stats} t={t} onClose={() => setTurnsOpen(false)} />
      ) : null}
    </>
  )
}

/**
 * A hover-or-click popover over the trigger. Opens on pointer rest (delayed)
 * or click (pinned); a pinned card stays open until an outside click or
 * Escape. The card is portaled and fixed-positioned beside the trigger.
 */
function BillingPopover({ renderTrigger, content, t }: {
  renderTrigger: (open: boolean) => ReactNode
  content: ReactNode
  t: (key: BillingKey) => string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const close = useCallback(() => {
    setPinned(false)
    setOpen(false)
  }, [])
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHoverTimer = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }
  const clearGraceTimer = () => {
    if (graceTimer.current !== null) {
      clearTimeout(graceTimer.current)
      graceTimer.current = null
    }
  }

  // Fixed-position from the trigger rect; track while open.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const wrapper = rootRef.current
      if (wrapper === null) return
      const r = wrapper.getBoundingClientRect()
      const h = cardRef.current?.offsetHeight ?? 0
      const top = r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, window.innerHeight - h - 8) : r.bottom + 8
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 320)), top })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  // Outside click closes a pinned card; Escape closes any card.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !cardRef.current?.contains(event.target)) {
        close()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  useEffect(() => () => { clearHoverTimer(); clearGraceTimer() }, [])

  const card = open && pos !== null && createPortal(
    <div ref={cardRef} className={css.card} style={{ left: pos.left, top: pos.top }}>
      {content}
    </div>,
    document.body,
  )

  return (
    <div
      ref={rootRef}
      className={css.root}
      onPointerEnter={() => {
        clearGraceTimer()
        if (open) return
        clearHoverTimer()
        hoverTimer.current = setTimeout(() => { setOpen(true) }, 350)
      }}
      onPointerLeave={() => {
        clearHoverTimer()
        if (open && !pinned) {
          graceTimer.current = setTimeout(() => { close() }, 200)
        }
      }}
    >
      <span
        className={css.triggerWrap}
        onClick={(e) => {
          e.stopPropagation()
          if (pinned) { close(); return }
          setPinned(true)
          setOpen(true)
        }}
      >
        {renderTrigger(open)}
      </span>
      {card}
    </div>
  )
}

/** The hover card body. */
function BillingCard({ stats, t, refreshing, onRefresh, onDetail }: {
  stats: SessionBillingStats
  t: (key: BillingKey) => string
  refreshing: boolean
  onRefresh: () => void
  onDetail: () => void
}) {
  const hitRate = Math.round(stats.cacheHitRate * 100)
  const currencies = Object.keys(stats.cost)
  const turns = stats.turns ?? []
  const contextRatio = stats.contextWindow !== undefined && stats.lastRequestInputTokens !== undefined
    && stats.contextWindow > 0
    ? stats.lastRequestInputTokens / stats.contextWindow
    : undefined
  return (
    <div className={css.cardInner}>
      <div className={css.cardHead}>
        <div className={css.titleGroup}>
          <span className={css.cardTitle}>{t('card.title')}</span>
          <button
            type="button"
            className={css.refresh}
            aria-label={t('refresh.aria')}
            title={t('refresh.title')}
            disabled={refreshing}
            onClick={onRefresh}
          >
            <IconRefreshOutline16 size={12} />
          </button>
        </div>
        <div className={css.headActions}>
          <button
            type="button"
            className={css.detail}
            aria-label={t('card.detail.aria')}
            title={t('card.detail')}
            onClick={onDetail}
          >
            {t('card.detail')}
          </button>
          <button
            type="button"
            className={css.settings}
            aria-label={t('settings.open')}
            title={t('settings.open')}
            onClick={() => { openBillingSettings(t, stats.currentModel) }}
          >
            <IconSettingsOutline14 />
          </button>
        </div>
      </div>
      {stats.currentModel !== undefined
        ? (
          <div className={css.modelLine}>
            <span className={css.modelProvider}>{stats.currentModel.provider}</span>
            <span className={css.modelSlash}>/</span>
            <span className={css.modelName}>{stats.currentModel.model}</span>
            {stats.currentModel.reasoningEffort !== undefined
              ? <span className={css.modelEffort}>{stats.currentModel.reasoningEffort}</span>
              : null}
          </div>
        )
        : null}
      {contextRatio !== undefined ? (
        <ContextBar ratio={contextRatio} t={t} stats={stats} />
      ) : null}
      <dl className={css.grid}>
        <dt><BillingLabel label={t('row.input')} hint={t('row.cacheHit')} /></dt><dd>{formatTokens(stats.cacheReadTokens)}</dd>
        <dt><BillingLabel label={t('row.input')} hint={t('row.cacheMiss')} /></dt><dd>{formatTokens(stats.uncachedInputTokens)}</dd>
        {stats.cacheWriteTokens > 0
          ? <><dt>{t('row.cacheWrite')}</dt><dd>{formatTokens(stats.cacheWriteTokens)}</dd></>
          : null}
        <dt>{t('row.output')}</dt><dd>{formatTokens(stats.outputTokens)}</dd>
        <dt>{t('row.cacheHitRate')}</dt><dd>{`${hitRate}%`}</dd>
      </dl>

      {currencies.length > 0
        ? (
          <div className={css.costBlock}>
            {currencies.map(currency => (
              <CostRows key={currency} stats={stats} currency={currency} t={t} />
            ))}
          </div>
        )
        : null}

      {turns.length > 0 ? (
        <TurnsMiniChart turns={turns} t={t} />
      ) : null}
    </div>
  )
}

/** The context-usage bar: the most recent request's total input over the
 *  model's context window (real, folded from the log). Hidden when either
 *  value is absent — no estimate. */
function ContextBar({ ratio, t, stats }: {
  ratio: number
  t: (key: BillingKey) => string
  stats: SessionBillingStats
}) {
  const pct = Math.min(100, Math.round(ratio * 100))
  const near = ratio >= CONTEXT_WARN_THRESHOLD
  const singleTurnBig = ratio >= SINGLE_TURN_WARN_RATIO
  const windowK = stats.contextWindow !== undefined ? formatTokens(stats.contextWindow) : ''
  const usedK = stats.lastRequestInputTokens !== undefined ? formatTokens(stats.lastRequestInputTokens) : ''
  return (
    <div className={css.contextBlock}>
      <div className={css.contextLabelRow}>
        <span className={css.contextLabel}>{t('card.contextUsed')}</span>
        <span className={css.contextValue}>{`${pct}%`}</span>
      </div>
      <div className={css.contextTrack}>
        <div className={`${css.contextFill}${near ? ` ${css.contextFillNear}` : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className={css.contextMeta}>
        {`${usedK} / ${windowK}`}
        {stats.maxOutputTokens !== undefined
          ? ` · ${t('capability.output')} ${formatTokens(stats.maxOutputTokens)}`
          : ''}
      </div>
      {singleTurnBig && !near
        ? <div className={css.contextHint}>{`${t('turn.lastInput')} ${pct}%`}</div>
        : null}
      {near ? <div className={css.contextWarn}>{t('card.contextNear')}</div> : null}
    </div>
  )
}

/** A compact horizontal bar per conversation TURN (a turn's tool-calling
 *  steps merge into one bar; see aggregateTurns). Only the most recent few
 *  turns fit the card width; newest turn is on the LEFT (descending). */
function TurnsMiniChart({ turns, t }: {
  turns: TurnCost[]
  t: (key: BillingKey) => string
}) {
  const aggregated = aggregateTurns(turns)
  const recent = aggregated.slice(-10).reverse()
  const max = Math.max(...recent.map(r => r.cost), 1)
  return (
    <div className={css.turnsBlock}>
      <div className={css.turnsHead}>
        <span className={css.turnsLabel}>{t('card.turns')}</span>
        <span className={css.turnsCount}>{t('card.turnsCount').replace('{count}', String(aggregated.length))}</span>
      </div>
      <div className={css.turnsBars}>
        {recent.map((turn, i) => (
          <div key={i} className={css.turnRow} title={`${t('turn.turn')} ${turn.turn} · ${formatPrice(turn.cost, currencySymbol(turn.currency))} · ${t('turn.hitRate')} ${Math.round(turn.cacheHitRate * 100)}%`}>
            <span className={css.turnNo}>{turn.turn}</span>
            <div className={css.turnTrack}>
              <div
                className={`${css.turnFill}${turn.period === 'peak' ? ` ${css.turnFillPeak}` : ''}`}
                style={{ width: `${Math.max(2, (turn.cost / max) * 100)}%` }}
              />
            </div>
            <span className={css.turnCost}>{formatPrice(turn.cost, currencySymbol(turn.currency))}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Cost + period-split rows for one currency. */
function CostRows({ stats, currency, t }: {
  stats: SessionBillingStats
  currency: string
  t: (key: BillingKey) => string
}) {
  const symbol = currencySymbol(currency)
  const period = stats.byPeriod[currency]
  return (
    <div className={css.costRows}>
      <div className={css.costRow}>
        <span className={css.costLabel}>{t('row.cost')}</span>
        <span className={css.costValue}>{formatPrice(stats.cost[currency] ?? 0, symbol)}</span>
      </div>
      {stats.hasPeakConfig && period !== undefined
        ? (
          <div className={css.periodRows}>
            <div className={css.periodRow}>
              <span className={css.periodLabel}>{t('period.offPeak')}</span>
              <span className={css.periodValue}>{formatPrice(period.offPeak, symbol)}</span>
            </div>
            <div className={css.periodRow}>
              <span className={css.periodLabel}>{t('period.peak')}</span>
              <span className={css.periodValue}>{formatPrice(period.peak, symbol)}</span>
            </div>
          </div>
        )
        : null}
    </div>
  )
}

function badgeText(stats: SessionBillingStats, t: (key: BillingKey) => string): string {
  // Models used but none priced → 「未登记价格」. No requests → zero.
  if (stats.requestCount === 0 && stats.unpricedRequestCount > 0) return t('card.unpriced')
  const entries = Object.entries(stats.cost).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return formatPrice(0, '¥')
  // Every currency is shown, never mixed: `¥1.20 + $0.35`.
  return entries.map(([code, units]) => formatPrice(units, currencySymbol(code))).join(' + ')
}

/**
 * Open the DSH settings panel to the Billing section, and — when a current
 * model is known — queue a locate request so the section expands the
 * provider and scrolls the model row into view.
 *
 * The settings trigger has no stable attribute hook, so disambiguate among
 * the dialog-popover buttons: this plugin's own trigger is tagged
 * `data-billing-trigger`, the context meter's carries an `aria-label`; the
 * sidebar settings trigger is the remaining text-named one. The nav cell is
 * matched by this plugin's own registered (localized) label, polled until
 * the panel finishes mounting.
 */
function openBillingSettings(
  t: (key: BillingKey) => string,
  model?: { provider: string; model: string },
): void {
  const trigger = [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
    .find(b => !b.hasAttribute('data-billing-trigger') && !b.hasAttribute('aria-label'))
  if (trigger === undefined) return
  if (model !== undefined) requestLocateModel(model)
  trigger.click()
  const label = t('settings.nav')
  let attempts = 0
  const tick = (): void => {
    for (const cell of document.querySelectorAll('nav button')) {
      if (cell.textContent?.trim() === label) {
        (cell as HTMLButtonElement).click()
        return
      }
    }
    attempts += 1
    if (attempts < 20) window.setTimeout(tick, 50)
  }
  window.setTimeout(tick, 0)
}
