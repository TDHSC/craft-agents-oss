/**
 * Click-to-edit guard for user message bubbles.
 *
 * A click on the bubble starts editing, except when it is really something else: finishing a text
 * selection (drag to copy), or hitting an interactive part of the content (link, file badge,
 * attachment). Pure so the rule is testable without a DOM.
 */

/** Elements inside a bubble that own their click. File badges are `role="button"` spans. */
export const EDIT_CLICK_IGNORE_SELECTOR =
  'a, button, input, textarea, img, [role="button"], [role="link"], [data-edit-ignore]'

export interface EditClickTarget {
  closest(selector: string): unknown
}

export function shouldStartEditFromClick(
  target: EditClickTarget | null,
  selectedText: string,
): boolean {
  // Releasing a drag-selection fires a click; the user is copying, not editing.
  if (selectedText.trim().length > 0) return false
  if (target && target.closest(EDIT_CLICK_IGNORE_SELECTOR)) return false
  return true
}
