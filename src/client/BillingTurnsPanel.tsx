/**
 * BillingTurnsPanel: the per-turn consumption detail panel opened from the
 * billing card's "查看详情" button. Renders one chart with a cost/token
 * dimension toggle plus a scrollable consumption table — all CSS-drawn (no
 * chart library), portaled and fixed-positioned like the card.
 *
 * The chart follows the view toggle, in log order (oldest on the left,
 * newest on the right, so the time axis increases left→right). "按轮次"
 * merges each turn's tool-calling steps into one bar; "按请求" plots every
 * request as its own bar. The table below follows the same toggle: "按轮次"
 * lists turn rows newest-first; "按请求" shows the same newest-first turns as
 * COLLAPSIBLE groups — each turn header carries its aggregate and expands to
 * the per-request rows, so a session with hundreds of tool steps stays
 * navigable instead of one long flat list.
 *
 * Opens with the card's bounded `stats.turns` immediately, then fetches the
 * session's FULL history via the turns route and replaces it (load/fail are
 * inline states; a failure keeps the already-shown data).
 */
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatPrice, formatPriceAxis, formatTime, formatTokens } from './format.ts'
import { getTurns } from './billing-api.ts'
import { aggregateTurns, type SessionBillingStats, type TurnCost, type TurnSummary } from '../shared.ts'
import { currencySymbol } from './BillingAction.tsx'
import type { BillingKey } from './locales.ts'
import { useTooltipState } from './Tooltip.tsx'
import './theme.module.css'
import css from './BillingTurnsPanel.module.css'

/** Full props for the turns detail panel. */
export interface BillingTurnsPanelProps {
  sessionId: string
  stats: SessionBillingStats
  t: (key: BillingKey) => string
  onClose: () => void
}

/** "Nice" tick step: 1/2/5 × 10^n that keeps 2-5 ticks for the range. */
function niceStep(max: number): number {
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)))
  const norm = raw / pow
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1
  return step * pow
}

/** Vertical-axis ticks for a chart of the given max value. */
function axisTicks(max: number): number[] {
  const step = niceStep(max)
  const ticks: number[] = []
  for (let v = 0; v < max - 1e-9; v += step) ticks.push(v)
  ticks.push(max)
  return ticks
}

/** The chart/table label: `轮次 N` for a turn, `N.step` for a request. A
 *  request's label always carries its step so a single-request turn reads
 *  `N.1` — never a bare `N` that looks like a turn number. */
function turnLabel(row: TurnCost | TurnSummary, t: (key: BillingKey) => string): string {
  if ('requests' in row) return `${t('turn.turn')} ${row.turn}`
  return `${row.turn}.${row.step}`
}

/** X-axis label under a bar: NUMBERS ONLY (`12`, `12.3`). The full
 *  `轮次 N` / `N.step` text lives in the tooltip and the table; a wide
 *  localized label inside a fixed-width column would truncate into
 *  「轮次轮次轮次…」 (the header above the chart already says 按轮次). */
function axisBarLabel(row: TurnCost | TurnSummary): string {
  if ('requests' in row) return String(row.turn)
  return `${row.turn}.${row.step}`
}

/** One cost/token chart with a left-hand value axis, turns in log order
 *  (oldest on the left, newest on the right — the x-axis is chronological).
 *  `dense` = per-request mode: half-width bars for a macro trend view and
 *  sparser labels (a request-level axis is about shape, not per-bar IDs). */
function TurnChart({ rows, dimension, t, dense = false }: {
  rows: readonly TurnCost[] | readonly TurnSummary[]
  dimension: 'cost' | 'tokens'
  t: (key: BillingKey) => string
  dense?: boolean
}) {
  const maxCost = Math.max(...rows.map(r => r.cost), 1)
  const maxTokens = Math.max(...rows.map(r => r.inputTokens + r.outputTokens), 1)
  const max = dimension === 'cost' ? maxCost : maxTokens
  const ticks = axisTicks(max)
  // Fixed-width bars, chronological left→right; the chart column scrolls
  // horizontally while the value axis stays pinned on the left.
  // X-axis label thinning: labels are pure numbers (`12` / `12.3`) so they
  // fit a 24px column, but hundreds of bars would still smear — label every
  // k-th column (first and last always labelled; the tooltip names every
  // bar exactly). Dense (per-request) bars thin harder: the axis reads as
  // a macro timeline, exact IDs stay in the tooltip/table.
  const labelEvery = dense
    ? (rows.length > 80 ? 8 : rows.length > 40 ? 4 : 2)
    : (rows.length > 40 ? 4 : rows.length > 20 ? 2 : 1)
  // Axis unit: the dominant currency symbol for cost, "tok" for tokens.
  const symbol = dimension === 'cost'
    ? currencySymbol(rows.map(r => r.currency).sort((a, b) => a.localeCompare(b))[0] ?? 'CNY')
    : ''
  const axisLabel = (v: number): string => dimension === 'cost'
    ? formatPriceAxis(v, symbol)
    : formatTokens(v)
  // Shared tooltip state: one tooltip for both chart modes (same dwell as
  // the badge card and its buttons — interaction.ts is the single source).
  const [hovered, setHovered] = useState<TurnCost | TurnSummary | null>(null)
  const [, setTooltipAnchor, tooltip] = useTooltipState({
    label: hovered !== null
      ? dimension === 'cost'
        ? `${turnLabel(hovered, t)} · ${hovered.priced ? formatPrice(hovered.cost, currencySymbol(hovered.currency)) : t('turn.unpriced')}`
        : `${turnLabel(hovered, t)} · ${formatTokens(hovered.inputTokens)}/${formatTokens(hovered.outputTokens)}`
      : '',
    align: 'center',
  })

  return (
    <div className={css.chartWrap}>
      <div className={css.chartGrid}>
        <div className={css.axis}>
          {/* Render max→0 top→bottom so the 0 tick sits on the chart's
              bottom baseline (bars grow upward from the bottom). */}
          {[...ticks].reverse().map(v => (
            <span key={v} className={css.axisTick}>{axisLabel(v)}</span>
          ))}
        </div>
        <div className={dimension === 'cost'
          ? `${css.barChart} ${css.scrollX}${dense ? ` ${css.dense}` : ''}`
          : `${css.stackChart} ${css.scrollX}${dense ? ` ${css.dense}` : ''}`}>
          {rows.map((row, i) => {
            // Per-request mode: the FIRST request of each turn is a turn
            // boundary — extra leading gap (visual grouping); its axis label
            // (`N.1`) is always shown AND bolded, so turn starts are findable
            // at a glance without box outlines on the bars.
            const turnStart = dense && !('requests' in row) && row.step === 1
            const labelled = turnStart || i % labelEvery === 0 || i === rows.length - 1
            const colClass = turnStart ? `${css.barCol} ${css.turnStart}` : css.barCol
            return dimension === 'cost' ? (
              <div
                key={i}
                className={colClass}
                onPointerEnter={(e) => { setHovered(row); setTooltipAnchor(e.currentTarget) }}
                onPointerLeave={() => { setHovered(null); setTooltipAnchor(null) }}
              >
                <div
                  className={`${css.bar}${row.period === 'peak' ? ` ${css.barPeak}` : ''}${row.priced ? '' : ` ${css.barUnpriced}`}`}
                  style={{ height: `${Math.max(2, (row.cost / maxCost) * 100)}%` }}
                />
                <span className={css.barLabel}>{labelled ? axisBarLabel(row) : '\u00A0'}</span>
              </div>
            ) : (
              <div
                key={i}
                className={turnStart ? `${css.stackCol} ${css.turnStart}` : css.stackCol}
                onPointerEnter={(e) => { setHovered(row); setTooltipAnchor(e.currentTarget) }}
                onPointerLeave={() => { setHovered(null); setTooltipAnchor(null) }}
              >
                <div className={css.stackWrap}>
                  <div className={css.stackOutput} style={{ height: `${Math.max(1, (row.outputTokens / maxTokens) * 100)}%` }} />
                  <div className={css.stackCacheWrite} style={{ height: `${Math.max(0, (row.cacheWriteTokens / maxTokens) * 100)}%` }} />
                  <div className={css.stackCacheRead} style={{ height: `${Math.max(0, (row.cacheReadTokens / maxTokens) * 100)}%` }} />
                  <div className={css.stackUncached} style={{ height: `${Math.max(1, ((row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens) / maxTokens) * 100)}%` }} />
                </div>
                <span className={css.barLabel}>{labelled ? axisBarLabel(row) : '\u00A0'}</span>
              </div>
            )
          })}
        </div>
      </div>
      {tooltip}
    </div>
  )
}

/** The numeric cell columns shared by turn rows, turn-group headers and request rows. */
function TokenCells({ row, t }: { row: TurnCost | TurnSummary; t: (key: BillingKey) => string }) {
  const uncached = row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens
  return (
    <>
      <td className={css.tdNum}>{formatTokens(uncached)}</td>
      <td className={css.tdNum}>{row.cacheReadTokens > 0 ? formatTokens(row.cacheReadTokens) : '–'}</td>
      <td className={css.tdNum}>{row.cacheWriteTokens > 0 ? formatTokens(row.cacheWriteTokens) : '–'}</td>
      <td className={css.tdNum}>{formatTokens(row.outputTokens)}</td>
      <td className={css.tdNum}>{`${Math.round(row.cacheHitRate * 100)}%`}</td>
      <td className={css.tdNum}>
        {row.priced ? formatPrice(row.cost, currencySymbol(row.currency)) : <span className={css.unpricedTag}>{t('turn.unpriced')}</span>}
      </td>
    </>
  )
}

/** A flat turn row (the "按轮次" view): one line per turn, newest first. */
function TurnRow({ row, hasPeak, t }: {
  row: TurnSummary
  hasPeak: boolean
  t: (key: BillingKey) => string
}) {
  return (
    <tr>
      <td className={css.tdTurn}>{turnLabel(row, t)}</td>
      <td className={css.tdNum}>{formatTime(row.time)}</td>
      <TokenCells row={row} t={t} />
      {hasPeak ? (
        <td className={`${css.tdPeriod}${row.period === 'peak' ? ` ${css.tdPeriodPeak}` : ''}`}>
          {row.period === 'peak' ? t('period.peak') : t('period.offPeak')}
        </td>
      ) : null}
    </tr>
  )
}

/** One request row inside an expanded turn group. */
function RequestRow({ row, hasPeak, t }: {
  row: TurnCost
  hasPeak: boolean
  t: (key: BillingKey) => string
}) {
  return (
    <tr>
      <td className={css.tdTurn}>{turnLabel(row, t)}</td>
      <td className={css.tdNum}>{formatTime(row.time)}</td>
      <TokenCells row={row} t={t} />
      {hasPeak ? (
        <td className={`${css.tdPeriod}${row.period === 'peak' ? ` ${css.tdPeriodPeak}` : ''}`}>
          {row.period === 'peak' ? t('period.peak') : t('period.offPeak')}
        </td>
      ) : null}
    </tr>
  )
}

/** The portaled detail panel. */
export function BillingTurnsPanel({ sessionId, stats, t, onClose }: BillingTurnsPanelProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const [turns, setTurns] = useState<TurnCost[]>(() => stats.turns ?? [])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dimension, setDimension] = useState<'cost' | 'tokens'>('cost')
  // Default to turn-grouped; "按请求" switches to collapsible turn groups.
  const [grouped, setGrouped] = useState(true)
  // Turn numbers expanded in the "按请求" view (default: none — collapsed).
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set())
  const hasPeak = stats.hasPeakConfig === true

  // The chart follows the view toggle, in log order (oldest on the left,
  // newest on the right — the time axis increases left→right). "按轮次"
  // aggregates each turn's tool-calling steps into one bar; "按请求" plots
  // every request as its own bar. The table below is always newest-first.
  const chartRows = useMemo(
    () => grouped ? aggregateTurns(turns) : turns,
    [grouped, turns],
  )
  const turnSummaries = useMemo(() => aggregateTurns(turns), [turns])
  const turnSummariesDesc = useMemo(() => [...turnSummaries].reverse(), [turnSummaries])

  // The request view groups raw requests by turn, newest turn first; each
  // turn's requests stay in log order (ascending step). The group header
  // aggregate is computed in TurnGroupRows over the whole group
  // (multi-currency safe).
  const turnGroups = useMemo(() => {
    const groups: { turn: number; requests: TurnCost[] }[] = []
    const index = new Map<number, number>()
    for (const row of turns) {
      let gi = index.get(row.turn)
      if (gi === undefined) {
        gi = groups.length
        index.set(row.turn, gi)
        groups.push({ turn: row.turn, requests: [] })
      }
      groups[gi]!.requests.push(row)
    }
    // Newest turn first.
    return groups.reverse()
  }, [turns])

  const toggleTurn = (turn: number): void => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }

  // Center a 560px-wide panel over the viewport (narrow screens collapse).
  useLayoutEffect(() => {
    const place = () => {
      const width = window.innerWidth >= 600 ? 560 : Math.max(0, window.innerWidth - 16)
      setPos({
        left: Math.max(8, (window.innerWidth - width) / 2),
        top: Math.max(8, (window.innerHeight - 480) / 2),
        width,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [])

  // Load the full history on open (replaces the bounded card turns).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    void getTurns(sessionId).then(full => {
      if (cancelled) return
      setTurns(full)
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setFailed(true)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const panel = pos !== null && createPortal(
    <div className={css.mask} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={css.panel} style={{ left: pos.left, top: pos.top, width: pos.width }} role="dialog" aria-label={t('turn.title')}>
        <div className={css.head}>
          <span className={css.title}>{t('turn.title')}</span>
          <div className={css.headActions}>
            <button
              type="button"
              className={css.refresh}
              aria-label={t('refresh.aria')}
              disabled={loading}
              onClick={() => {
                setLoading(true)
                setFailed(false)
                void getTurns(sessionId).then(full => { setTurns(full); setLoading(false) }).catch(() => { setFailed(true); setLoading(false) })
              }}
            >
              {t('refresh.title')}
            </button>
            <button type="button" className={css.close} onClick={onClose} aria-label={t('turn.close')}>×</button>
          </div>
        </div>

        {loading && turns.length === 0 ? <div className={css.empty}>{t('settings.loading')}</div> : null}
        {failed && turns.length === 0 ? <div className={css.empty}>{t('settings.error')}</div> : null}

        {turns.length === 0 && !loading && !failed ? (
          <div className={css.empty}>{t('turn.empty')}</div>
        ) : turns.length > 0 ? (
          <>
            <section className={css.section}>
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{dimension === 'cost' ? t('turn.metric.cost') : t('turn.metric.tokens')}</span>
                <div className={css.switches}>
                  <div className={css.dimSwitch}>
                    <button type="button" className={dimension === 'cost' ? `${css.dimBtn} ${css.dimBtnActive}` : css.dimBtn} onClick={() => setDimension('cost')}>{t('turn.metric.cost')}</button>
                    <button type="button" className={dimension === 'tokens' ? `${css.dimBtn} ${css.dimBtnActive}` : css.dimBtn} onClick={() => setDimension('tokens')}>{t('turn.metric.tokens')}</button>
                  </div>
                  <div className={css.dimSwitch}>
                    <button type="button" className={grouped ? `${css.dimBtn} ${css.dimBtnActive}` : css.dimBtn} onClick={() => setGrouped(true)}>{t('turn.group.turn')}</button>
                    <button type="button" className={!grouped ? `${css.dimBtn} ${css.dimBtnActive}` : css.dimBtn} onClick={() => setGrouped(false)}>{t('turn.group.request')}</button>
                  </div>
                </div>
              </div>
              <TurnChart rows={chartRows} dimension={dimension} t={t} dense={!grouped} />
              <div className={css.legend}>
                {dimension === 'cost' ? (
                  hasPeak ? (
                    <>
                      <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendOffPeak}`} />{t('period.offPeak')}</span>
                      <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendPeak}`} />{t('period.peak')}</span>
                    </>
                  ) : null
                ) : (
                  <>
                    <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendUncached}`} />{t('turn.bucket.miss')}</span>
                    <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendCacheRead}`} />{t('turn.bucket.hit')}</span>
                    <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendCacheWrite}`} />{t('turn.bucket.write')}</span>
                    <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendOutput}`} />{t('turn.bucket.output')}</span>
                  </>
                )}
                <span className={css.legendItem}><span className={`${css.legendSwatch} ${css.legendUnpriced}`} />{t('turn.unpriced')}</span>
              </div>
              {dimension === 'tokens' ? (
                <div className={css.bucketNote}>{t('turn.bucket.note')}</div>
              ) : null}
            </section>

            <section className={css.section}>
              <span className={css.sectionTitle}>{grouped ? t('card.turns') : t('turn.title')}</span>
              <div className={css.tableWrap}>
                <table className={css.table}>
                  <thead>
                    <tr>
                      <th>{grouped ? t('turn.group.turn') : t('turn.turn')}</th>
                      <th>{t('turn.time')}</th>
                      <th>{t('turn.cacheMiss')}</th>
                      <th>{t('turn.cacheHit')}</th>
                      <th>{t('turn.cacheWrite')}</th>
                      <th>{t('turn.output')}</th>
                      <th>{t('turn.hitRate')}</th>
                      <th>{t('turn.cost')}</th>
                      {hasPeak ? <th>{t('turn.period')}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {grouped ? (
                      turnSummariesDesc.map((row, i) => <TurnRow key={i} row={row} hasPeak={hasPeak} t={t} />)
                    ) : (
                      turnGroups.map(group => (
                        <TurnGroupRows
                          key={group.turn}
                          group={group}
                          open={expanded.has(group.turn)}
                          hasPeak={hasPeak}
                          t={t}
                          onToggle={() => toggleTurn(group.turn)}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )

  return <div ref={rootRef}>{panel}</div>
}

/** A collapsible turn group in the "按请求" view: a header row with the turn
 *  aggregate plus an expand toggle, and the turn's request rows when open. */
function TurnGroupRows({ group, open, hasPeak, t, onToggle }: {
  group: { turn: number; requests: TurnCost[] }
  open: boolean
  hasPeak: boolean
  t: (key: BillingKey) => string
  onToggle: () => void
}) {
  // Aggregate the whole group: a multi-currency turn produces one summary per
  // currency, so the header shows summed buckets/cost and the last request's
  // time/period (the summary carries the per-currency first row).
  const summary = aggregateTurns(group.requests)
  const totalCost = summary.reduce((acc, s) => acc + s.cost, 0)
  const totalInput = summary.reduce((acc, s) => acc + s.inputTokens, 0)
  const totalRead = summary.reduce((acc, s) => acc + s.cacheReadTokens, 0)
  const totalWrite = summary.reduce((acc, s) => acc + s.cacheWriteTokens, 0)
  const totalOutput = summary.reduce((acc, s) => acc + s.outputTokens, 0)
  const uncached = totalInput - totalRead - totalWrite
  const hitRate = uncached + totalRead > 0 ? totalRead / (uncached + totalRead) : 0
  const last = group.requests[group.requests.length - 1]!
  const headerRow: TurnSummary = {
    turn: group.turn,
    step: 1,
    time: last.time,
    inputTokens: totalInput,
    cacheReadTokens: totalRead,
    cacheWriteTokens: totalWrite,
    outputTokens: totalOutput,
    cacheHitRate: hitRate,
    cost: totalCost,
    currency: last.currency,
    period: last.period,
    priced: group.requests.every(r => r.priced),
    requests: group.requests.length,
  }
  return (
    <>
      <tr className={css.groupHead} onClick={onToggle}>
        <td className={css.tdTurn}>
          <span className={`${css.groupChevron}${open ? ` ${css.groupChevronOpen}` : ''}`}>{'›'}</span>
          {turnLabel(headerRow, t)}
          <span className={css.groupCount}>{`${group.requests.length} ${t('turn.group.requests')}`}</span>
        </td>
        <td className={css.tdNum}>{formatTime(headerRow.time)}</td>
        <TokenCells row={headerRow} t={t} />
        {hasPeak ? (
          <td className={`${css.tdPeriod}${headerRow.period === 'peak' ? ` ${css.tdPeriodPeak}` : ''}`}>
            {headerRow.period === 'peak' ? t('period.peak') : t('period.offPeak')}
          </td>
        ) : null}
      </tr>
      {open ? group.requests.map((row, i) => (
        <RequestRow key={i} row={row} hasPeak={hasPeak} t={t} />
      )) : null}
    </>
  )
}

export default BillingTurnsPanel
