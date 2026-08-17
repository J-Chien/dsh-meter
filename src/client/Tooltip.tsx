/**
 * Tooltip: one shared tooltip implementation for the billing UI, replacing
 * scattered native `title` attributes.
 *
 * Why not native titles:
 *  - they are invisible to screen readers / keyboards (no hover on touch)
 *  - they show at an OS-fixed delay that nothing else in the GUI matches
 *    (the two delays were visibly out of sync with the badge card)
 *  - they cannot be styled to the dsh surface tokens
 *
 * Usage — three forms:
 *  - wrap any element: <Tooltip label={...}> <button/> </Tooltip>
 *    (tooltip follows the hovered child)
 *  - attach to an existing element via a ref (no DOM wrapper):
 *      const [ref, tooltip] = useTooltip(anchor, label)
 *      <div ref={ref}>{tooltip}</div>
 *  - programmatic hover for chart bars, where the anchor is the hovered
 *    bar (set by onPointerEnter) and content is built from that bar's row:
 *      const [anchor, tip] = useTooltipState(content)
 *      <div onPointerEnter={e => setAnchor(e.currentTarget)} ...>{tip}</div>
 *
 * Behavior (constants in ./interaction.ts):
 *  - opens after TOOLTIP_DELAY_MS of resting on the anchor
 *  - follows the anchor while hovered; repositions on scroll/resize
 *  - closes instantly on pointer leave, Escape, or when the anchor unmounts
 *  - above every surface this plugin owns (badge card 100 < turns mask 200
 *    < this tooltip 300)
 *
 * Accessible: the anchor keeps its aria-label/aria-labelledby; the tooltip
 * role='tooltip' is inert (no tab stop, no pointer events).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { TOOLTIP_DELAY_MS } from './interaction.ts'
import './theme.module.css'
import css from './Tooltip.module.css'

/** Horizontal alignment of the tip relative to the anchor's center. */
export type TooltipAlign = 'start' | 'center' | 'end'

export interface TooltipOptions {
  /** Text to show. Empty/undefined = tooltip stays closed. */
  label?: string
  /** Horizontal alignment relative to the anchor's center. Default 'center'. */
  align?: TooltipAlign
  /** Whether the tooltip may open. Defaults to true. */
  disabled?: boolean
}

interface AnchorRect {
  left: number
  top: number
  bottom: number
  right: number
}

function anchorRectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, bottom: r.bottom, right: r.right }
}

/**
 * The shared tooltip portal: a fixed-position bubble above the anchor,
 * kept inside the viewport. Closes on leave/Escape/scroll-reposition.
 */
function TooltipPortal({ anchor, label, align }: {
  anchor: AnchorRect | null
  label: string
  align: TooltipAlign
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Reposition whenever the anchor moves (the bar chart grows as new
  // projection frames arrive) or the window scrolls/resizes.
  const place = useCallback(() => {
    if (anchor === null) return
    const el = ref.current
    if (el === null) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const pad = 4
    let left = anchor.left + (anchor.right - anchor.left) / 2
    if (align === 'start') left = anchor.left
    else if (align === 'end') left = anchor.right
    left = Math.min(Math.max(left, pad), window.innerWidth - w - pad)
    let top = anchor.top - h - 6
    if (top < pad) top = anchor.bottom + 6
    setPos({ left, top })
  }, [anchor, align])

  useLayoutEffect(() => {
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [place])

  const [visible, setVisible] = useState(false)
  useLayoutEffect(() => { setVisible(pos !== null) }, [pos])

  return createPortal(
    <div ref={ref} className={visible ? `${css.tooltip} ${css.tooltipVisible}` : css.tooltip}
      style={pos !== null ? { left: pos.left, top: pos.top } : undefined}
      role="tooltip">
      {label}
    </div>,
    document.body,
  )
}

/**
 * Programmatic tooltip state: `anchor` is the currently hovered element,
 * `tooltip` is the portal to render. The open dwell + Escape handling live
 * here so chart bars and wrapped children behave identically.
 */
export function useTooltipState(options: TooltipOptions = {}): [
  anchor: Element | null,
  setAnchor: (el: Element | null) => void,
  tooltip: ReactNode,
] {
  const { label = '', align = 'center', disabled = false } = options
  const [anchorEl, setAnchorEl] = useState<Element | null>(null)
  const [rect, setRect] = useState<AnchorRect | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)

  const clearTimer = (): void => {
    if (openTimer.current !== null) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }

  const close = useCallback(() => {
    clearTimer()
    setOpen(false)
    setAnchorEl(null)
    setRect(null)
  }, [])

  const setAnchor = useCallback((el: Element | null) => {
    clearTimer()
    if (el === null || disabled) {
      close()
      return
    }
    setAnchorEl(el)
    setRect(anchorRectOf(el))
    openTimer.current = setTimeout(() => { setOpen(true) }, TOOLTIP_DELAY_MS)
  }, [disabled, close])

  // Escape closes an open tooltip.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  // Follow the anchor while hovered (the chart re-renders on new frames).
  useEffect(() => {
    if (anchorEl === null || !open) return
    let alive = true
    const track = (): void => {
      if (alive && anchorEl.isConnected) setRect(anchorRectOf(anchorEl))
      else if (alive) close()
    }
    const timer = window.setInterval(track, 400)
    track()
    return () => { alive = false; window.clearInterval(timer) }
  }, [anchorEl, open, close])

  // Clean up the open timer on unmount.
  useEffect(() => clearTimer, [])

  // An empty label keeps the tooltip closed (the anchor may still be set).
  const tooltip = open && rect !== null && label !== ''
    ? <TooltipPortal anchor={rect} label={label} align={align} />
    : null
  return [anchorEl, setAnchor, tooltip]
}

/**
 * Wrap a child: the tooltip anchors on the child and opens after the shared
 * dwell. The child keeps all its own props/refs untouched.
 */
export function Tooltip({ label, align = 'center', disabled = false, children }: TooltipOptions & {
  children: ReactNode
}): ReactNode {
  const [, setAnchor, tooltip] = useTooltipState({ label, align, disabled })
  return (
    <>
      <span
        className={css.anchor}
        onPointerEnter={e => setAnchor(e.currentTarget)}
        onPointerLeave={() => setAnchor(null)}
        onFocus={() => setAnchor(null)}
      >
        {children}
      </span>
      {tooltip}
    </>
  )
}

export default Tooltip
