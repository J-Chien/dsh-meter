/**
 * Shared field label: main word plus an optional parenthetical hint rendered
 * smaller (e.g. 输入（缓存命中）). Both the session-header card and the
 * settings page use this so naming and ordering stay in one place.
 */
import css from './BillingLabel.module.css'

/** A label with an optional small parenthetical hint. */
export function BillingLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className={css.label}>
      {label}
      {hint !== undefined ? <span className={css.hint}>{hint}</span> : null}
    </span>
  )
}
