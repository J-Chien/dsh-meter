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
import { CONTEXT_WARN_THRESHOLD, EMPTY_STATS, turnGrowths, estimateCompactionEta, estimateCompactionGrowth, inPeakWindow, aggregateTurns, type PriceTable, type SessionBillingStats, type TurnCost, type TurnSummary } from '../shared.ts'
import { formatPrice, formatTime, formatTokens } from './format.ts'
import { getPriceTable, refreshSessionStats } from './billing-api.ts'
import { requestLocateModel } from './locate.ts'
import type {} from './types.ts'
import { BillingLabel } from './BillingLabel.tsx'
import { NS, type BillingKey } from './locales.ts'
import { BillingTurnsPanel } from './BillingTurnsPanel.tsx'
import { CLICK_DELAY_MS, HOVER_CLOSE_MS, HOVER_OPEN_MS } from './interaction.ts'
import { Tooltip, useTooltipState } from './Tooltip.tsx'
import './theme.module.css'
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
 *
 * Timing contract (src/client/interaction.ts — the plugin-wide source):
 *  - pointer rests HOVER_OPEN_MS on the trigger → card opens (hover mode)
 *  - pointer leaves trigger + card + bridge for HOVER_CLOSE_MS → card closes
 *  - a click within CLICK_DELAY_MS of pointer-down cancels the hover open
 *    and pins the card instead (click pins, never flicker-opens)
 *
 * The portaled card sits 8px below the trigger, so BOTH the card and an
 * invisible bridge rect (trigger.bottom → card.top) participate in the hover
 * surface: crossing the gap keeps the card open (this was a dead zone where
 * the card would close before the pointer reached it).
 */
function BillingPopover({ renderTrigger, content }: {
  renderTrigger: (open: boolean) => ReactNode
  content: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const bridgeRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerDownAt = useRef<number | null>(null)
  // Trigger bottom (for bridge placement), captured while placing the card.
  const triggerBottom = useRef<number | null>(null)

  const close = useCallback(() => {
    setPinned(false)
    setOpen(false)
  }, [])

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
  // Both cards and tooltips share the same open/close dwell, so the whole
  // billing UI feels like one surface.
  const cancelHoverOpen = (): void => {
    clearHoverTimer()
    clearGraceTimer()
  }

  // Fixed-position from the trigger rect; track while open.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const wrapper = rootRef.current
      if (wrapper === null) return
      const r = wrapper.getBoundingClientRect()
      triggerBottom.current = r.bottom
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

  // Outside click closes a pinned card; Escape closes any card. The bridge
  // counts as inside: a pointerdown in the trigger↔card gap must not close
  // a pinned card (the bridge swallows that click for hover tracking).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !cardRef.current?.contains(event.target)
        && !bridgeRef.current?.contains(event.target)) {
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

  useEffect(() => () => { cancelHoverOpen() }, [])

  // The hover surface: trigger + card + the bridge between them. Each side
  // resets the grace timer on enter, so crossing the gap never counts as a
  // leave; the timer only fires after leaving ALL three.
  const cancelLeave = (): void => {
    clearHoverTimer()
    clearGraceTimer()
  }
  const scheduleLeave = (): void => {
    if (open && !pinned) {
      graceTimer.current = setTimeout(() => { close() }, HOVER_CLOSE_MS)
    }
  }

  const card = open && pos !== null && createPortal(
    <div
      ref={cardRef}
      className={css.card}
      style={{ left: pos.left, top: pos.top }}
      onPointerEnter={cancelLeave}
      onPointerLeave={scheduleLeave}
    >
      {content}
    </div>,
    document.body,
  )

  // The bridge rect only exists while the card is open; it bridges the gap
  // the pointer must cross between trigger bottom and card top (above the
  // card when the card flipped up, below it otherwise).
  const bridge = open && pos !== null && createPortal(
    <div
      ref={bridgeRef}
      className={css.cardBridge}
      style={{
        left: pos.left,
        top: (triggerBottom.current ?? pos.top) < pos.top ? pos.top - 12 : (triggerBottom.current ?? pos.top),
        width: 320,
      }}
      onPointerEnter={cancelLeave}
      onPointerLeave={scheduleLeave}
    />,
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
        hoverTimer.current = setTimeout(() => { setOpen(true) }, HOVER_OPEN_MS)
      }}
      onPointerLeave={() => {
        clearHoverTimer()
        scheduleLeave()
      }}
      onPointerDown={() => { pointerDownAt.current = Date.now() }}
    >
      <span
        className={css.triggerWrap}
        onClick={(e) => {
          e.stopPropagation()
          // A click right after pointer-down cancels the pending hover open:
          // the user wants a pinned card, not a hover flicker.
          if (pointerDownAt.current !== null && Date.now() - pointerDownAt.current <= CLICK_DELAY_MS) {
            cancelHoverOpen()
          }
          pointerDownAt.current = null
          if (pinned) { close(); return }
          setPinned(true)
          setOpen(true)
        }}
      >
        {renderTrigger(open)}
      </span>
      {card}
      {bridge}
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
          <span className={css.titleSub}>{t('card.titleSub')}</span>
        </div>
        <div className={css.headActions}>
          {/* All three share the plugin-wide Tooltip dwell (interaction.ts), so
           *  button hints and chart hovers feel like one system. */}
          <Tooltip label={t('refresh.title')}>
            <button
              type="button"
              className={css.refresh}
              aria-label={t('refresh.aria')}
              disabled={refreshing}
              onClick={onRefresh}
            >
              <IconRefreshOutline16 size={12} />
            </button>
          </Tooltip>
          <Tooltip label={t('card.detail.aria')}>
            <button
              type="button"
              className={css.detail}
              aria-label={t('card.detail.aria')}
              onClick={onDetail}
            >
              {t('card.detail')}
            </button>
          </Tooltip>
          <Tooltip label={t('settings.open.aria')}>
            <button
              type="button"
              className={css.settings}
              aria-label={t('settings.open.aria')}
              onClick={() => { openBillingSettings(t, stats.currentModel) }}
            >
              <IconSettingsOutline14 />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className={css.body}>
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

        {/* Hero figures first: the two numbers that matter most. */}
        <MetricGrid stats={stats} t={t} />

        {/* Token detail: no duplicate hit-rate / total rows — those live
         *  in the hero. The peak/off-peak split is the only extra here,
         *  and only when the session actually configures peak windows. */}
        <div className={css.tokensCard}>
          <dl className={css.grid}>
            <dt><BillingLabel label={t('row.input')} hint={t('row.cacheHit')} hintInline /></dt><dd>{formatTokens(stats.cacheReadTokens)}</dd>
            <dt><BillingLabel label={t('row.input')} hint={t('row.cacheMiss')} hintInline /></dt><dd>{formatTokens(stats.uncachedInputTokens)}</dd>
            {stats.cacheWriteTokens > 0
              ? <><dt>{t('row.cacheWrite')}</dt><dd>{formatTokens(stats.cacheWriteTokens)}</dd></>
              : null}
            <dt>{t('row.output')}</dt><dd>{formatTokens(stats.outputTokens)}</dd>
          </dl>

          {stats.hasPeakConfig ? (
            <PeriodSplit stats={stats} t={t} />
          ) : null}
        </div>

        {turns.length > 0 ? (
          <TurnsBarChart turns={turns} t={t} />
        ) : null}

        {contextRatio !== undefined ? (
          <ContextBar ratio={contextRatio} t={t} stats={stats} />
        ) : null}
      </div>
    </div>
  )
}

/** The two hero figures: total cost + cache hit rate. Type-driven, no boxes.
 *  The hit rate picks up a quiet success tint only at a genuinely high rate;
 *  otherwise it stays on the neutral label ladder. */
function MetricGrid({ stats, t }: {
  stats: SessionBillingStats
  t: (key: BillingKey) => string
}) {
  const hitRate = Math.round(stats.cacheHitRate * 100)
  const currencies = Object.keys(stats.cost)
  const totalText = currencies.length === 0
    ? formatPrice(0, '¥')
    : currencies.map(c => formatPrice(stats.cost[c] ?? 0, currencySymbol(c))).join(' + ')
  const hitHigh = hitRate >= 70
  return (
    <div className={css.metricGrid}>
      <div className={css.metric}>
        <span className={css.metricLabel}>{t('row.cost')}</span>
        <span className={css.metricValue}>{totalText}</span>
      </div>
      <div className={css.metric}>
        <span className={css.metricLabel}>{t('row.cacheHitRate')}</span>
        <span className={`${css.metricValue}${hitHigh ? ` ${css.metricHitHigh}` : ''}`}>{`${hitRate}%`}</span>
      </div>
    </div>
  )
}

/** The context bar: the most recent request's total input over the model's
 *  advertised context window. NOTE the window is the provider's INPUT+OUTPUT
 *  combined limit (harness RequestContext.contextWindow), so the ratio is
 *  'input vs total window', not a pure input-occupancy number. Hidden when
 *  either value is absent — no estimate.
 *
 *  The trigger tick marks compaction-basic's DEFAULT thresholdRatio (0.8 ×
 *  contextWindow). It is NOT read from the host's live config: that value is
 *  private cordis patch configuration (no settings namespace, no runtime
 *  face), so a profile overriding it would make the tick approximate. We
 *  keep the tick and say "default".
 *
 *  Forecast model: per-turn NET input growth = difference between each
 *  turn's total input and the previous turn's (a turn's input repeats the
 *  whole history, so the LEVEL is useless — only the DELTA is growth).
 *  Deltas <= 0 are dropped (compaction resets the level). Over the last 10
 *  turns, the trimmed mean of positive deltas (min & max excluded) is the
 *  stable growth rate; ETA = headroom / that rate. Still rough: the harness
 *  meters the whole surface estimate; we only see real usage. */
function ContextBar({ ratio, t, stats }: {
  ratio: number
  t: (key: BillingKey) => string
  stats: SessionBillingStats
}) {
  const pct = Math.min(100, Math.round(ratio * 100))
  const near = ratio >= CONTEXT_WARN_THRESHOLD
  const windowK = stats.contextWindow !== undefined ? formatTokens(stats.contextWindow) : ''
  const usedK = stats.lastRequestInputTokens !== undefined ? formatTokens(stats.lastRequestInputTokens) : ''
  const capText = stats.maxOutputTokens !== undefined
    ? ` · ${t('capability.output')} ${formatTokens(stats.maxOutputTokens)}`
    : ''
  const usageText = `${usedK} / ${windowK}${capText}`
  const compactions = stats.compactions
  const compacted = compactions !== undefined && compactions.count > 0

  // Forecast (see the model note in shared.ts). Growth = snapshot deltas
  // (this turn's last-request total input minus the previous turn's) —
  // immune to cache expiry: a cache miss replays the whole history as
  // uncached tokens but the TOTAL input snapshot stays the same. Growth
  // comes from COMPLETED turn transitions only (the in-progress turn's
  // snapshot keeps growing until it closes). Headroom uses the live
  // snapshot (last request's total input).
  let forecast: string | undefined
  const windowTokens = stats.contextWindow
  const lastInput = stats.lastRequestInputTokens
  if (windowTokens !== undefined && lastInput !== undefined && stats.turns.length >= 2) {
    const growths = turnGrowths(stats.turns)
    const completed = growths.slice(0, -1) // drop the in-progress turn's growth
    const growth = estimateCompactionGrowth(completed)
    const eta = estimateCompactionEta(completed, windowTokens, lastInput)
    if (growth !== undefined && eta !== undefined) {
      const headroom = windowTokens * 0.8 - lastInput
      forecast = t('card.compactEta')
        .replace('{turns}', String(eta))
        .replace('{avg}', formatTokens(Math.round(growth)))
        .replace('{headroom}', formatTokens(Math.max(0, Math.round(headroom))))
    }
  }

  return (
    <div className={css.contextBlock}>
      <div className={css.contextLabelRow}>
        <span className={css.contextLabel}>{t('card.contextUsed')}</span>
        <span className={css.contextValue}>{`${pct}% · ${usageText}`}</span>
      </div>
      <div className={css.contextTrack}>
        {/* Default compaction trigger line (compaction-basic thresholdRatio
         *  0.8 × window). Styled thin + translucent so it reads as a
         *  reference line, not a data mark. */}
        <div className={css.contextTrigger} style={{ left: '80%' }} title={t('card.compactTrigger')} />
        <div className={`${css.contextFill}${near ? ` ${css.contextFillNear}` : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {compacted
        ? (
          <div className={css.contextHint}>
            {t('card.compactDone')
              .replace('{count}', String(compactions.count))
              .replace('{time}', compactions.lastTime !== undefined ? formatTime(compactions.lastTime) : '—')
              .replace('{tokens}', compactions.lastShadowedTokens !== undefined ? formatTokens(compactions.lastShadowedTokens) : '—')}
          </div>
        )
        : null}
      {forecast !== undefined ? <div className={css.contextHint}>{forecast}</div> : null}
      {near ? <div className={css.contextWarn}>{t('card.contextNear')}</div> : null}
    </div>
  )
}

/** A compact vertical bar chart of per-turn INPUT TOKENS. X-axis is time
 *  (oldest left → newest right), bar height = the turn's total input tokens
 *  (the section sits in the token-usage context — a cost column here would
 *  be off-language). Peak turns keep a warm tint (their inputs bill at the
 *  peak rate). Hover shows the full picture: turn, token usage, cost, hit
 *  rate. Bars keep a fixed width; the chart measures its own width and
 *  shows as many recent turns as fit — no hardcoded count. */
/** One bar in the mini chart: the turn's NET context growth (uncached
 *  input + output; cache read/write excluded — reads are history re-reads,
 *  writes are this turn's own input). Tooltip carries the same net plus
 *  the turn's real cost and hit rate. */
function TurnBar({ turn, level, max, t }: {
  turn: TurnSummary
  level: number
  max: number
  t: (key: BillingKey) => string
}) {
  const [, setTooltipAnchor, tooltip] = useTooltipState({
    label: `${t('turn.turn')} ${turn.turn} · ${t('turn.growth')} ${formatTokens(level)} · ${formatPrice(turn.cost, currencySymbol(turn.currency))} · ${t('turn.hitRate')} ${Math.round(turn.cacheHitRate * 100)}%`,
    align: 'center',
  })
  return (
    <div
      className={css.turnBarWrap}
      onPointerEnter={(e) => setTooltipAnchor(e.currentTarget)}
      onPointerLeave={() => setTooltipAnchor(null)}
    >
      <div
        className={`${css.turnBar}${turn.period === 'peak' ? ` ${css.turnBarPeak}` : ''}`}
        style={{ height: `${Math.max(4, (level / max) * 100)}%` }}
      />
      <span className={css.turnNo}>{turn.turn}</span>
      {tooltip}
    </div>
  )
}

function TurnsBarChart({ turns, t }: {
  turns: TurnCost[]
  t: (key: BillingKey) => string
}) {
  const aggregated = aggregateTurns(turns)
  // Bar height + tooltip use the turn's SNAPSHOT-DELTA growth: this turn's
  // last-request total input minus the previous turn's. Cache-state immune
  // (a cache miss replays history as uncached but the total is the same).
  // The first turn has no predecessor → no growth bar (it contributes 0).
  const growths = turnGrowths(turns)
  const growthByTurn = new Map<number, number>()
  aggregated.forEach((turn, i) => growthByTurn.set(turn.turn, i > 0 ? growths[i - 1] ?? 0 : 0))
  // Fit count from the measured strip width: each column is 18px and needs
  // a 3px breathing gap, so 21px per column; the 4px is the 2×2px strip
  // padding. space-between spreads the leftover evenly. Falls back to 10
  // before the first measure lands.
  const stripRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(10)
  useEffect(() => {
    const el = stripRef.current
    if (el === null) return
    const measure = (): void => {
      const columns = Math.floor((el.clientWidth - 4) / 21)
      setFit(Math.max(4, columns))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const recent = aggregated.slice(-fit)
  const max = Math.max(...recent.map(r => growthByTurn.get(r.turn) ?? 0), 1)
  return (
    <div className={css.turnsBlock}>
      <div className={css.turnsHead}>
        <span className={css.turnsLabel}>{t('card.turns')}</span>
        <span className={css.turnsCount}>{t('card.turnsCount').replace('{count}', String(aggregated.length))}</span>
      </div>
      <div ref={stripRef} className={css.turnsChart}>
        {recent.map((turn) => (
          <TurnBar key={turn.turn} turn={turn} level={growthByTurn.get(turn.turn) ?? 0} max={max} t={t} />
        ))}
      </div>
    </div>
  )
}

/** Peak/off-peak cost split per currency, shown only when the session
 *  configures peak windows. The total itself lives in the hero — no
 *  duplicate here. */
function PeriodSplit({ stats, t }: {
  stats: SessionBillingStats
  t: (key: BillingKey) => string
}) {
  return (
    <div className={css.periodBlock}>
      {Object.keys(stats.cost).map(currency => {
        const symbol = currencySymbol(currency)
        const period = stats.byPeriod[currency]
        if (period === undefined) return null
        return (
          <div key={currency} className={css.periodRows}>
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
      })}
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
