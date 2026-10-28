import { describe, expect, it } from 'bun:test'
import { isMessageEditable, shouldCancelInlineEdit } from '../inline-edit-guards'

describe('shouldCancelInlineEdit', () => {
  it('leaves edit mode on a click outside the editor', () => {
    expect(shouldCancelInlineEdit({ insideEditor: false, overlayOpen: false })).toBe(true)
  })

  it('keeps the edit when the click is inside the editor', () => {
    expect(shouldCancelInlineEdit({ insideEditor: true, overlayOpen: false })).toBe(false)
  })

  it('keeps the edit when the click belongs to an open menu or dialog (portals sit outside the editor)', () => {
    expect(shouldCancelInlineEdit({ insideEditor: false, overlayOpen: true })).toBe(false)
  })
})

describe('isMessageEditable', () => {
  const user = { role: 'user', content: 'hello' }

  it('allows a confirmed visible user message', () => {
    expect(isMessageEditable(user)).toBe(true)
    expect(isMessageEditable({ ...user, badges: [{ type: 'skill' }, { type: 'file' }] })).toBe(true)
  })

  it('rejects other roles, hidden nudges and unconfirmed messages', () => {
    expect(isMessageEditable({ ...user, role: 'assistant' })).toBe(false)
    expect(isMessageEditable({ ...user, hidden: true })).toBe(false)
    expect(isMessageEditable({ ...user, isPending: true })).toBe(false)
  })

  it('rejects messages whose hidden metadata the composer cannot rebuild', () => {
    expect(isMessageEditable({ ...user, badges: [{ type: 'context' }] })).toBe(false)
    expect(isMessageEditable({ ...user, badges: [{ type: 'edit_request' }] })).toBe(false)
  })

  it('rejects SDK slash commands and empty content', () => {
    expect(isMessageEditable({ ...user, content: '/compact now' })).toBe(false)
    expect(isMessageEditable({ ...user, badges: [{ type: 'command' }] })).toBe(false)
    expect(isMessageEditable({ ...user, content: '   ' })).toBe(false)
  })
})
