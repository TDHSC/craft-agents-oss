/**
 * Decisions of the inline prompt editor that depend only on event facts, kept pure for testing.
 */

/**
 * A pointer-down leaves edit mode unless it landed in the editor, or an overlay is open: menus,
 * dropdowns and dialogs opened from the composer live in portals outside the editor's DOM, and the
 * click that dismisses them must not also throw away the edit.
 */
export function shouldCancelInlineEdit(event: { insideEditor: boolean; overlayOpen: boolean }): boolean {
  return !event.insideEditor && !event.overlayOpen
}

/**
 * Which sent messages can be edited and re-sent.
 *
 * Not editable: messages the server has not confirmed yet (its id is not stored), hidden
 * system nudges, and messages carrying hidden metadata the composer cannot show or rebuild
 * (EditPopover context / edit-request badges, which hide ranges of the text), or SDK commands.
 */
export function isMessageEditable(message: {
  role: string
  hidden?: boolean
  isPending?: boolean
  content: string
  badges?: Array<{ type: string }>
}): boolean {
  if (message.role !== 'user' || message.hidden || message.isPending) return false
  if (message.badges?.some(b => b.type === 'context' || b.type === 'edit_request' || b.type === 'command')) return false
  if (/^\/[a-z]+(\s|$)/i.test(message.content.trim())) return false
  return message.content.trim().length > 0
}
