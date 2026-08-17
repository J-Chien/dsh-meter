/**
 * Interaction-timing constants for the billing UI. ONE source of truth for
 * every hover/click dwell in this plugin:
 *
 *  - HOVER_OPEN_MS       pointer must rest this long before a hover surface
 *                        opens (badge card, tooltip). Matches the GUI's
 *                        menu-open dwell.
 *  - HOVER_CLOSE_MS      grace period after leaving a hover surface before
 *                        it closes (lets the pointer cross the gap between
 *                        trigger and card / into the tooltip).
 *  - CLICK_DELAY_MS      click fires this long after the pointer rests; a
 *                        click inside this window cancels the hover open
 *                        (click pins, never flicker-opens).
 *  - TOOLTIP_DELAY_MS    shared 'pointer must rest on the target' dwell for
 *                        Tooltip (kept separate from HOVER_OPEN_MS so a
 *                        chart tooltip may stay instant-to-follow).
 *
 * Timings live here instead of per-component magic numbers so the badge
 * card, the chart tooltips and any future hover surface all feel identical.
 */
export const HOVER_OPEN_MS = 200
export const HOVER_CLOSE_MS = 300
export const CLICK_DELAY_MS = 100
export const TOOLTIP_DELAY_MS = 400
