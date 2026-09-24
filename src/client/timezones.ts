/**
 * IANA timezone choices for the settings card's timezone combobox, and the
 * keyword filter behind it. Pure and dependency-free so the filter is testable
 * without a DOM — a picker whose filtering silently stops matching is worse
 * than a plain text field, because the user cannot tell why nothing appears.
 *
 * The list comes from the engine (`Intl.supportedValuesOf('timeZone')`) rather
 * than a hand-maintained table: zone names change with the tz database, and a
 * baked list would drift silently. A runtime without `supportedValuesOf` yields
 * no choices, and the field degrades to free text with the same validation.
 */

/** One pickable zone: the IANA id plus its city segment for keyword matching. */
export interface TimezoneChoice {
  /** IANA id, e.g. `Asia/Shanghai` — the value written to the config. */
  readonly name: string
  /** City segment, spaces restored (`America/New_York` → `New York`). */
  readonly label: string
}

/** True for a name `Intl` accepts as a timezone (the same check the fold's dates use). */
export function isIanaTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** The engine's zone list, in its own (alphabetical) order; empty when unavailable. */
export function timezoneChoices(): TimezoneChoice[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  if (typeof supported !== 'function') return []
  let zones: string[]
  try {
    zones = supported.call(Intl, 'timeZone')
  } catch {
    return []
  }
  return zones.map(zone => ({
    name: zone,
    label: zone.slice(zone.indexOf('/') + 1).replace(/_/g, ' '),
  }))
}

/**
 * Filter the choices by keyword, best matches first. A query matches the IANA
 * id or the city, and a match at a segment start outranks one in the middle —
 * so `shanghai` finds `Asia/Shanghai` immediately, and `america` lists the
 * American zones. An empty query shows the head of the list as a hint.
 *
 * @param choices - the full zone list, in display order.
 * @param rawQuery - what the user typed (case-insensitive, trimmed).
 * @param limit - maximum matches to return.
 * @returns the matching choices, at most `limit` of them.
 */
export function matchTimezones(
  choices: readonly TimezoneChoice[],
  rawQuery: string,
  limit = 8,
): TimezoneChoice[] {
  const query = rawQuery.trim().toLowerCase()
  if (query === '') return choices.slice(0, limit)
  const starts: TimezoneChoice[] = []
  const contains: TimezoneChoice[] = []
  for (const choice of choices) {
    const name = choice.name.toLowerCase()
    const label = choice.label.toLowerCase()
    if (name.startsWith(query) || label.startsWith(query)) starts.push(choice)
    else if (name.includes(query) || label.includes(query)) contains.push(choice)
  }
  return [...starts, ...contains].slice(0, limit)
}
