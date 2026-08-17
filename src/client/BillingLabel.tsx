/**
 * Shared field label: main word plus an optional parenthetical hint rendered
 * smaller (e.g. 输入（缓存命中）). Both the session-header card and the
 * settings page use this so naming and ordering stay in one place.
 *
 * `hintInline` renders the hint at the same size as the label (only tinted),
 * for dense rows where a smaller hint would make adjacent figures look
 * uneven — e.g. the session card's token rows.
 */
import './theme.module.css'
import css from './BillingLabel.module.css'

/** A label with an optional small parenthetical hint. */
export function BillingLabel({ label, hint, hintInline }: { label: string; hint?: string; hintInline?: boolean }) {
  return (
    <span className={css.label}>
      {label}
      {hint !== undefined ? <span className={hintInline ? css.hintInline : css.hint}>{hint}</span> : null}
    </span>
  )
}
