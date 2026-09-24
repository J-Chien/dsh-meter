/**
 * Session-header billing action: a persistent entry (always visible) that
 * opens a billing card on hover or click. The card shows per-session token
 * buckets, cache hit rate, per-currency cost (with a 空闲/高峰 split when the
 * models configure peak periods), a refresh button, and a Settings button
 * that opens the settings panel (the price editor is a native
 * `settings.plugins.tab` page in the panel's plugins section).
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  IconDataOutlineMedium, IconListPenOutlineMedium, IconRefreshOutlineMedium, IconSettingsOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { COMPACT_TRIGGER_RATIO, CONTEXT_WARN_THRESHOLD, EMPTY_STATS, anyPeakActive, turnGrowthByTurn, turnGrowths, estimateCompactionEta, estimateCompactionGrowth, aggregateTurns, type SessionBillingStats, type SubagentBillingRow, type SubagentsBillingStats, type TurnCost, type TurnSummary } from '../shared.ts'
import { formatCacheHitPercent, formatCompactTok, formatExactTok, formatPrice, formatTime, formatTokens } from './format.ts'
import { refreshSessionStats, getSubagentsStats } from './billing-api.ts'
import { usePricingTable } from './pricing-scope.ts'
import { requestLocateModel } from './locate.ts'
import type {} from './types.ts'
import { type BillingKey } from './locales.ts'
import { BillingTurnsPanel } from './BillingTurnsPanel.tsx'
import { CLICK_DELAY_MS, HOVER_CLOSE_MS, HOVER_OPEN_MS } from './interaction.ts'
import { Tooltip, useTooltipState } from './Tooltip.tsx'
import './theme.module.css'
import css from './BillingAction.module.css'

/** Poll cadence for the subagent section while a child is running. */
const SUBAGENTS_POLL_MS = 5_000

/** The inject face apply passes to this component. */
export interface BillingActionInjected {
  t: (key: BillingKey) => string
}

/** Full props for the session-header billing action. */
export type BillingActionProps =
  PropsRuntime<'conversation.session.header.actions'> & BillingActionInjected

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
  const [turnsOpen, setTurnsOpen] = useState(false)
  // Bumped by the refresh button so the subagent section (route-fetched, not
  // on the projection feed) re-runs its fetch together with the main stats.
  const [subagentsReload, setSubagentsReload] = useState(0)
  // The popover's close(), exposed to the card body (the settings gear must
  // dismiss the card before opening the settings panel).
  const closeCardRef = useRef<(() => void) | null>(null)

  // The price table rides the shared configForms binding (pricing-scope.ts): a
  // Host document, whose update event re-seeds every subscriber — across tabs
  // too, so the peak tag never judges by stale window hours. Undefined while
  // loading or on a remote (non-loopback) browser; the tag just stays hidden.
  const table = usePricingTable()

  // A new projection frame supersedes any refresh override.
  useEffect(() => { setOverride(undefined) }, [projected])

  const stats = override ?? projected ?? EMPTY_STATS
  const peakModels = stats.peakModels ?? []
  const peakKey = peakModels.join('|')

  // Re-evaluate the peak tag when the table lands or changes, when the
  // session's peak-model set changes (a settings save re-mounts the
  // projection), and once a minute so the tag flips at window boundaries
  // without host round-trips. `anyPeakActive` resolves the fold's
  // "provider/model[/effort]" keys against the table's known rows — model
  // ids may themselves contain '/' (wpsai's vendor-prefixed ids), so the
  // keys are never re-split here.
  useEffect(() => {
    const evaluate = (): void => setPeakNow(anyPeakActive(peakModels, table, Date.now()))
    evaluate()
    const timer = window.setInterval(evaluate, 60_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content
  }, [peakKey, table])

  const doRefresh = useCallback(async (): Promise<void> => {
    if (refreshing) return
    setRefreshing(true)
    try {
      // The peak tag re-evaluates off the peakKey effect above when the fresh
      // stats land; the table itself stays live via the scope subscription.
      // The subagent section watches subagentsReload and refetches too.
      setSubagentsReload(key => key + 1)
      setOverride(await refreshSessionStats(String(sessionId)))
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, sessionId])

  const badge = badgeText(stats, t)
  const hasPeakModels = peakModels.length > 0
  const unpriced = stats.requestCount === 0 && stats.unpricedRequestCount > 0

  const card = useMemo(() => (
    <BillingCard sessionId={String(sessionId)} stats={stats} t={t} refreshing={refreshing}
      subagentsReload={subagentsReload}
      onRefresh={() => void doRefresh()}
      onDetail={() => setTurnsOpen(true)}
      onSettings={() => {
        // Close the popover BEFORE opening the settings panel — the card is
        // pinned over the conversation and would otherwise float on top of
        // the settings page (the sidebar click is programmatic, so the
        // outside-click dismiss never fires).
        closeCardRef.current?.()
        openBillingSettings(stats.currentModel)
      }} />
  ), [sessionId, stats, t, refreshing, subagentsReload, doRefresh])

  return (
    <>
      <BillingPopover
        closeRef={closeCardRef}
        renderTrigger={open => (
          <button type="button" data-billing-trigger="" className={css.trigger} aria-label={t('trigger.aria')} aria-haspopup="dialog" aria-expanded={open}>
            <IconDataOutlineMedium className={css.triggerIcon} />
            <span className={unpriced ? css.unpricedBadge : css.badge}>{badge}</span>
            {hasPeakModels ? (
              <span className={peakNow ? css.peakTag : css.offPeakTag}>
                {peakNow ? t('trigger.peak') : t('trigger.offPeak')}
              </span>
            ) : null}
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
function BillingPopover({ renderTrigger, content, closeRef }: {
  renderTrigger: (open: boolean) => ReactNode
  content: ReactNode
  /** Filled with the popover's close() so the card body can dismiss itself
   *  (the settings gear closes the card before opening the settings panel). */
  closeRef?: MutableRefObject<(() => void) | null>
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

  // Publish close() to the caller (card body) once mounted.
  useEffect(() => {
    if (closeRef === undefined) return
    closeRef.current = close
    return () => { closeRef.current = null }
  }, [close, closeRef])

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

  // Fixed-position from the trigger rect; track while open. The card renders
  // (hidden) from the first open frame, so this layout effect can measure
  // cardRef and the flip-up branch works on FIRST open; a ResizeObserver
  // re-places when the content grows (new projection frames add rows).
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = () => {
      const wrapper = rootRef.current
      if (wrapper === null) return
      const r = wrapper.getBoundingClientRect()
      triggerBottom.current = r.bottom
      const h = cardRef.current?.offsetHeight ?? 0
      const w = cardRef.current?.offsetWidth ?? 320
      const top = r.bottom + 8 + h > window.innerHeight - 8 ? Math.max(8, window.innerHeight - h - 8) : r.bottom + 8
      setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w)), top })
    }
    place()
    const cardEl = cardRef.current
    const observer = cardEl !== null
      ? new ResizeObserver(() => { place() })
      : null
    if (cardEl !== null) observer?.observe(cardEl)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      observer?.disconnect()
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

  // Render the card from the first open frame (hidden until measured) so the
  // layout effect above can measure its real size immediately.
  const card = open && createPortal(
    <div
      ref={cardRef}
      className={css.card}
      data-billing-card=""
      style={pos !== null
        ? { left: pos.left, top: pos.top }
        : { visibility: 'hidden' }}
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

/** The hover card body: the official panel frame (title row → 0.5px rule →
 *  label/value details grid) with the billing-only sections folded in below
 *  it, each separated by the same hairline. */
function BillingCard({ sessionId, stats, t, refreshing, subagentsReload, onRefresh, onDetail, onSettings }: {
  sessionId: string
  stats: SessionBillingStats
  t: (key: BillingKey) => string
  refreshing: boolean
  /** Bumped to force the subagent section's fetch (refresh button). */
  subagentsReload: number
  onRefresh: () => void
  onDetail: () => void
  onSettings: () => void
}) {
  const turns = stats.turns ?? []
  const contextRatio = stats.contextWindow !== undefined && stats.lastRequestInputTokens !== undefined
    && stats.contextWindow > 0
    ? stats.lastRequestInputTokens / stats.contextWindow
    : undefined
  const promptTokens = stats.uncachedInputTokens + stats.cacheReadTokens
  const cacheHit = formatCacheHitPercent(stats.cacheReadTokens, promptTokens)
  return (
    <div className={css.cardInner}>
      <div className={css.title}>
        <span className={css.titleLabel}>
          <IconDataOutlineMedium />
          {t('card.title')}
        </span>
        {/* Actions sit left of the headline figure so the figure stays flush
         *  right, exactly where the official panel puts its total. */}
        <span className={css.headActions}>
          {/* All three share the plugin-wide Tooltip dwell (interaction.ts), so
           *  button hints and chart hovers feel like one system. */}
          <Tooltip label={t('refresh.title')}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('refresh.aria')}
              disabled={refreshing}
              onClick={onRefresh}
            >
              <IconRefreshOutlineMedium size={14} />
            </button>
          </Tooltip>
          <Tooltip label={t('card.detail.aria')}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('card.detail.aria')}
              onClick={onDetail}
            >
              <IconListPenOutlineMedium size={14} />
            </button>
          </Tooltip>
          <Tooltip label={t('settings.open.aria')}>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('settings.open.aria')}
              onClick={onSettings}
            >
              <IconSettingsOutlineMedium size={14} />
            </button>
          </Tooltip>
        </span>
        <span className={css.titleValue}>{totalCostText(stats)}</span>
      </div>

      <div className={css.titleRule} aria-hidden="true" />

      <dl className={css.details}>
        {stats.currentModel !== undefined
          ? (
            <>
              <dt>{t('row.model')}</dt>
              <dd className={css.route}>{modelRoute(stats.currentModel)}</dd>
            </>
          )
          : null}
        {cacheHit !== null ? <><dt>{t('row.cacheHit')}</dt><dd>{cacheHit}</dd></> : null}
        <dt>{t('row.uncachedInput')}</dt><dd>{formatExactTok(stats.uncachedInputTokens)}</dd>
        <dt>{t('row.cacheRead')}</dt><dd>{formatExactTok(stats.cacheReadTokens)}</dd>
        {stats.cacheWriteTokens > 0
          ? <><dt>{t('row.cacheWrite')}</dt><dd>{formatExactTok(stats.cacheWriteTokens)}</dd></>
          : null}
        <dt>{t('row.output')}</dt><dd>{formatExactTok(stats.outputTokens)}</dd>
      </dl>

      {stats.hasPeakConfig ? (
        <>
          <div className={css.sectionRule} aria-hidden="true" />
          <PeriodSplit stats={stats} t={t} />
        </>
      ) : null}

      {turns.length > 0 ? (
        <>
          <div className={css.sectionRule} aria-hidden="true" />
          <TurnsBarChart turns={turns} t={t} />
        </>
      ) : null}

      <SubagentsSection sessionId={sessionId} t={t} reloadKey={subagentsReload} />

      {contextRatio !== undefined ? (
        <>
          <div className={css.sectionRule} aria-hidden="true" />
          <ContextBar ratio={contextRatio} t={t} stats={stats} />
        </>
      ) : null}
    </div>
  )
}

/** The card's headline figure: the session total across every currency it
 *  touched, joined rather than mixed (`¥1.20 + $0.35`); an unpriced session
 *  reads as a zero. Lives in the title row, where the official panel keeps
 *  its headline number. */
function totalCostText(stats: SessionBillingStats): string {
  const currencies = Object.keys(stats.cost).sort((a, b) => a.localeCompare(b))
  if (currencies.length === 0) return formatPrice(0, '¥')
  return currencies.map(c => formatPrice(stats.cost[c] ?? 0, currencySymbol(c))).join(' + ')
}

/** The provider/model route exactly as the official panel renders it:
 *  `provider/model`, with the request's reasoning effort appended. */
function modelRoute(model: { provider: string; model: string; reasoningEffort?: string }): string {
  const route = `${model.provider}/${model.model}`
  return model.reasoningEffort !== undefined ? `${route}/${model.reasoningEffort}` : route
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
 *  Forecast model: per-turn context GROWTH = snapshot deltas (this turn's
 *  last-request total input minus the previous turn's) — cache-state immune
 *  (a cache miss replays the whole history as uncached tokens, but the TOTAL
 *  input snapshot stays the same). Deltas <= 0 are dropped (compaction
 *  resets the level). Growth is the SMALLER of two trimmed means (min & max
 *  excluded): over all completed turns AND over the last 10 — early one-off
 *  loads can't inflate it, a recent light streak can't over-promise. Growth
 *  comes from COMPLETED turn transitions only (the in-progress turn's
 *  snapshot keeps growing until it closes). Headroom uses the live snapshot
 *  (last request's total input). Still rough: the harness meters the whole
 *  surface estimate; we only see real usage. */
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
  // Old host frames (pre-restart) may lack compactions.cost — defend.
  const compactCostText = Object.entries(compactions?.cost ?? {})
    .map(([code, units]) => formatPrice(units, currencySymbol(code)))
    .join(' + ')

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
      const headroom = windowTokens * COMPACT_TRIGGER_RATIO - lastInput
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
         *  × window). Styled thin + translucent so it reads as a reference
         *  line, not a data mark. The Tooltip wrapper span is in-flow with a
         *  zero-size box, so the line's absolute positioning (containing
         *  block = contextTrack) is unaffected. */}
        <Tooltip label={t('card.compactTrigger')}>
          <div className={css.contextTrigger} style={{ left: `${COMPACT_TRIGGER_RATIO * 100}%` }} />
        </Tooltip>
        <div className={`${css.contextFill}${near ? ` ${css.contextFillNear}` : ''}`} style={{ width: `${pct}%` }} />
      </div>
      {compacted
        ? (
          <div className={css.contextHint}>
            {t('card.compactDone')
              .replace('{count}', String(compactions.count))
              .replace('{time}', compactions.lastTime !== undefined ? formatTime(compactions.lastTime) : '—')
              .replace('{tokens}', compactions.lastShadowedTokens !== undefined ? formatTokens(compactions.lastShadowedTokens) : '—')
              .replace('{cost}', compactCostText === ''
                ? ''
                : t('card.compactCost').replace('{cost}', compactCostText))}
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
/** One bar in the mini chart: the turn's context GROWTH as a snapshot delta
 *  (this turn's last-request total input minus the previous turn's) —
 *  cache-state immune, since a cache miss replays history as uncached tokens
 *  but the total snapshot stays the same. The first turn has no predecessor
 *  → no growth bar. Tooltip carries the same growth plus the turn's real
 *  cost and hit rate. */
function TurnBar({ turn, level, max, t }: {
  turn: TurnSummary
  level: number
  max: number
  t: (key: BillingKey) => string
}) {
  const hit = formatCacheHitPercent(turn.cacheReadTokens, turn.inputTokens - turn.cacheWriteTokens)
  const [, setTooltipAnchor, tooltip] = useTooltipState({
    label: `${t('turn.turn')} ${turn.turn} · ${t('turn.growth')} ${formatTokens(level)} · ${formatPrice(turn.cost, currencySymbol(turn.currency))} · ${t('turn.hitRate')} ${hit ?? '—'}`,
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
  // TURN 1's growth is its whole snapshot (its predecessor is the empty
  // context — everything it loaded is new occupancy); the earliest turn of
  // a truncated frame stays unkeyed (its predecessor is outside the window).
  // Keyed by turn number, so a multi-currency turn (two aggregated rows)
  // still reads the same growth — no index-alignment drift.
  const growthByTurn = turnGrowthByTurn(turns)
  // Fit count from the measured strip width: each column is 18px and needs
  // a 3px breathing gap, so 21px per column; the 4px is the 2×2px strip
  // padding. Columns pack left→right (uniform 3px gap, timeline order) and
  // overflow scrolls. Falls back to 10 before the first measure lands.
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
          <TurnBar key={`${turn.turn}:${turn.currency}`} turn={turn} level={growthByTurn.get(turn.turn) ?? 0} max={max} t={t} />
        ))}
      </div>
    </div>
  )
}

/** Peak/off-peak cost split per currency, shown only when the session
 *  configures peak windows. The total itself is the title figure — no
 *  duplicate here. Rows join the same dt/dd grid as the token block. */
function PeriodSplit({ stats, t }: {
  stats: SessionBillingStats
  t: (key: BillingKey) => string
}) {
  return (
    <dl className={css.details}>
      {Object.keys(stats.cost).sort((a, b) => a.localeCompare(b)).map(currency => {
        const symbol = currencySymbol(currency)
        const period = stats.byPeriod[currency]
        if (period === undefined) return null
        return (
          <Fragment key={currency}>
            <dt>{t('period.offPeak')}</dt>
            <dd>{formatPrice(period.offPeak, symbol)}</dd>
            <dt>{t('period.peak')}</dt>
            <dd>{formatPrice(period.peak, symbol)}</dd>
          </Fragment>
        )
      })}
    </dl>
  )
}

/** One subagent's display name: durable descriptor label when present,
 *  else the tail of the opaque session id. */
function subagentName(row: SubagentBillingRow): string {
  if (row.label !== undefined) return row.label
  const id = row.sessionId
  return id.length > 10 ? id.slice(-8) : id
}

/**
 * The card's subagent section: family totals plus one row per descendant.
 * Data is NOT on the projection (a running child keeps the parent's log
 * silent, and cold children are persistence-only), so it loads when the
 * card opens and re-polls every POLL while any child is still running;
 * the refresh button forces a refetch via `reloadKey`.
 *
 * Failures degrade QUIETLY: keep any previously loaded rows and otherwise
 * leave the whole section hidden — the route folds fresh on every call, so
 * the next open/reload retries anyway. A host older than this build simply
 * lacks the method (404) and would otherwise stamp an error onto EVERY
 * session, subagent-free ones included.
 */
function SubagentsSection({ sessionId, t, reloadKey }: {
  sessionId: string
  t: (key: BillingKey) => string
  reloadKey: number
}) {
  const [stats, setStats] = useState<SubagentsBillingStats | undefined>(undefined)

  // Fetch + poll while open: the interval keeps the LAST promise's decision —
  // a running child OR a pending backlog (the host warms cold folds in the
  // background a slice at a time) keeps the loop alive so the card converges
  // on the complete, exact bill without user action.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async (): Promise<void> => {
      try {
        const fresh = await getSubagentsStats(sessionId)
        if (!alive) return
        setStats(fresh)
        if (fresh.runningCount > 0 || (fresh.pendingCount ?? 0) > 0) {
          timer = setTimeout(() => { void load() }, SUBAGENTS_POLL_MS)
        }
      } catch {
        // Stay hidden (see the doc comment above).
      }
    }
    void load()
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [sessionId, reloadKey])

  // Nothing loaded yet, or a session genuinely without subagents: no section.
  if (stats === undefined || stats.totalCount === 0) return null

  // Per-currency totals/averages. The average divides by the host's FULL-walk
  // billed count (`billedCount`) — the visible `children` list may be capped
  // at 100 rows, so counting it here would skew averages on big trees.
  const currencies = Object.keys(stats.cost).sort((a, b) => a.localeCompare(b))
  const totalText = currencies.map(c => formatPrice(stats.cost[c] ?? 0, currencySymbol(c))).join(' + ')
  const avgText = currencies.map(c => {
    const billed = stats.billedCount?.[c] ?? stats.children.filter(child => (child.cost[c] ?? 0) > 0).length
    return formatPrice(billed > 0 ? Math.round((stats.cost[c] ?? 0) / billed) : 0, currencySymbol(c))
  }).join(' + ')

  return (
    <div className={css.subsBlock}>
      <div className={css.subsHead}>
        <span className={css.subsLabel}>{t('subagents.title')}</span>
        <span className={css.subsRunning}>
          {stats.runningCount > 0 ? `● ${t('subagents.running').replace('{count}', String(stats.runningCount))}` : ''}
        </span>
        <span className={css.subsSummary}>
          {t('subagents.summary')
            .replace('{direct}', String(stats.directCount))
            .replace('{total}', String(stats.totalCount))}
        </span>
      </div>
      {(stats.pendingCount ?? 0) > 0 ? (
        <div className={css.subsPending}>{t('subagents.pending').replace('{count}', String(stats.pendingCount))}</div>
      ) : null}
      {currencies.length > 0 ? (
        <div className={css.subsTotals}>
          <span>{t('subagents.totalCost')} <span className={css.subsAmount}>{totalText}</span></span>
          <span>{t('subagents.avgCost')} <span className={css.subsAmount}>{avgText}</span></span>
        </div>
      ) : null}
      {stats.truncated ? <div className={css.subsTruncated}>{t('subagents.truncated')}</div> : null}
      <div className={css.subsRows}>
        {stats.children.map(row => (
          <SubagentRowView key={row.sessionId} row={row} t={t} />
        ))}
      </div>
    </div>
  )
}

/** One subagent line: depth indent, activity dot, name, token totals, cost. */
function SubagentRowView({ row, t }: {
  row: SubagentBillingRow
  t: (key: BillingKey) => string
}) {
  const costEntries = Object.entries(row.cost)
    .filter(([, units]) => units > 0)
    .sort(([a], [b]) => a.localeCompare(b))
  const costText = costEntries.length === 0
    ? (row.unpricedRequestCount > 0 ? t('turn.unpriced') : '')
    : costEntries.map(([code, units]) => formatPrice(units, currencySymbol(code))).join(' + ')
  const [, setTooltipAnchor, tooltip] = useTooltipState({
    label: `${subagentName(row)} · ${t('row.input')} ${formatTokens(row.inputTokens)} · ${t('row.output')} ${formatTokens(row.outputTokens)}`,
    align: 'start',
  })
  return (
    <div
      className={css.subsRow}
      style={{ paddingLeft: `${(row.depth - 1) * 14}px` }}
      onPointerEnter={(e) => setTooltipAnchor(e.currentTarget)}
      onPointerLeave={() => setTooltipAnchor(null)}
    >
      <span
        className={`${css.subsDot}${row.activity !== 'running' ? ` ${css.subsDotOff}` : ''}${row.activity === 'cold' ? ` ${css.subsDotCold}` : ''}`}
        aria-label={t(`subagent.${row.activity}` as BillingKey)}
      />
      <span className={css.subsName}>{subagentName(row)}</span>
      <span className={css.subsTokens}>{`${formatTokens(row.inputTokens)} → ${formatTokens(row.outputTokens)}`}</span>
      <span className={`${css.subsCost}${row.unpricedRequestCount > 0 && row.requestCount === 0 ? ` ${css.subsCostUnpriced}` : ''}`}>
        {costText}
      </span>
      {tooltip}
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
 * Open the DSH settings panel, and — when a current model is known — queue a
 * locate request. The billing price editor is a native `settings.plugin.item`
 * card inside the panel's plugins tab (rc.7): the harness exposes no
 * navigation API to select a tab or expand a card (both are component-local
 * state), so the gear can only open the panel; the queued locate is consumed
 * by the card when it mounts (the user opens the plugins tab), expanding the
 * provider and scrolling the model row into view.
 *
 * The trigger is resolved by SLOT, not by inverse-elimination. The old rule
 * ("a `aria-haspopup="dialog"` button that is neither ours nor labelled")
 * silently became wrong when the chat added the turn-usage pill: that pill
 * opens a dialog, lives in the transcript and carries no `aria-label`, so the
 * gear clicked IT and opened 「本轮用量」 instead of the settings panel. The
 * sidebar's settings entry is the stable hook (the same `data-slot` anchor
 * better-sidebar's stylesheet uses), and the fallback keeps the search OUT of
 * the conversation column, where those unlabeled dialog pills live.
 *
 * @param model - the model to expand once the settings card mounts.
 */
function openBillingSettings(
  model?: { provider: string; model: string },
): void {
  const slot = document.querySelector('[data-slot="sidebar.settings"]')
  const trigger = slot instanceof HTMLButtonElement
    ? slot
    : slot?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
      ?? slot?.querySelector<HTMLButtonElement>('button')
      ?? [...document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')]
        .find(b => !b.hasAttribute('data-billing-trigger')
          && b.closest('[data-slot^="conversation."]') === null)
  if (trigger === undefined || trigger === null) return
  if (model !== undefined) requestLocateModel(model)
  trigger.click()
}
