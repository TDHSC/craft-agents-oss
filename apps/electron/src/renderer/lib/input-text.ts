/**
 * Coerce untrusted composer/draft values into plain text.
 *
 * The renderer normally stores draft text as a string, but installed builds can
 * encounter stale or malformed persisted values (for example an entire draft
 * object, or an object in the `text` field). Keep input call sites defensive so
 * `.trim()` and rich-text rendering never receive a non-string value.
 */
export function coerceInputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof String) return value.toString()

  if (typeof value === 'object') {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }

  return ''
}

/**
 * Whether Stop should put the last prompt back in the input. Only when the stopped turn
 * produced nothing (no reply text, no tool call after the last sent user message): resending
 * the prompt is then the natural next step. Otherwise the composer shows ▶ to continue
 * (`getResumableStop`), and putting the prompt back would invite a duplicate resend.
 */
export function shouldRestorePromptOnStop(
  messages: ReadonlyArray<{ role: string; content?: string; isQueued?: boolean }>,
): boolean {
  const lastUser = messages.findLastIndex(m => m.role === 'user' && !m.isQueued)
  if (lastUser === -1) return false
  return !messages.slice(lastUser + 1).some(m =>
    m.role === 'tool' || (m.role === 'assistant' && coerceInputText(m.content).trim() !== ''),
  )
}

/**
 * Combine an existing input draft with text being restored (e.g. the last
 * user message put back on Stop). Appends with a blank line so a half-typed
 * draft isn't clobbered; returns the non-empty side when the other is empty.
 */
export function appendRestoredInput(existing: string | undefined, restored: string | undefined): string {
  const existingText = coerceInputText(existing)
  const restoredText = coerceInputText(restored)
  if (!restoredText) return existingText
  return existingText ? `${existingText}\n\n${restoredText}` : restoredText
}
