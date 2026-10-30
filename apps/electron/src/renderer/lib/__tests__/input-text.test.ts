import { describe, expect, it } from 'bun:test'
import { appendRestoredInput, coerceInputText, shouldRestorePromptOnStop } from '../input-text'

describe('coerceInputText', () => {
  it('preserves plain strings', () => {
    expect(coerceInputText('hello')).toBe('hello')
  })

  it('treats nullish values as empty text', () => {
    expect(coerceInputText(undefined)).toBe('')
    expect(coerceInputText(null)).toBe('')
  })

  it('extracts text from draft-like objects', () => {
    expect(coerceInputText({ text: 'draft text', attachments: [] })).toBe('draft text')
  })

  it('drops malformed object values instead of returning [object Object]', () => {
    expect(coerceInputText({ text: { nested: true } })).toBe('')
    expect(coerceInputText({ value: 'not a supported shape' })).toBe('')
  })

  it('stringifies primitive scalar values', () => {
    expect(coerceInputText(42)).toBe('42')
    expect(coerceInputText(false)).toBe('false')
  })
})

describe('appendRestoredInput', () => {
  it('returns the restored text when there is no existing draft', () => {
    expect(appendRestoredInput('', 'hello')).toBe('hello')
    expect(appendRestoredInput(undefined, 'hello')).toBe('hello')
  })

  it('appends restored text below an existing draft with a blank line', () => {
    expect(appendRestoredInput('draft', 'restored')).toBe('draft\n\nrestored')
  })

  it('returns the existing draft unchanged when there is nothing to restore', () => {
    expect(appendRestoredInput('draft', '')).toBe('draft')
    expect(appendRestoredInput('draft', undefined)).toBe('draft')
  })

  it('returns empty string when both sides are empty', () => {
    expect(appendRestoredInput('', '')).toBe('')
    expect(appendRestoredInput(undefined, undefined)).toBe('')
  })

  it('coerces malformed (non-string) persisted draft values defensively', () => {
    expect(appendRestoredInput({ text: 'draft' } as unknown as string, 'msg')).toBe('draft\n\nmsg')
  })
})

describe('shouldRestorePromptOnStop', () => {
  const m = (role: string, extra: { content?: string; isQueued?: boolean } = {}) => ({ role, ...extra })

  it('restores when the stopped turn produced nothing', () => {
    expect(shouldRestorePromptOnStop([m('user', { content: 'hi' })])).toBe(true)
    expect(shouldRestorePromptOnStop([m('user'), m('assistant', { content: 'ok' }), m('user', { content: 'again' })])).toBe(true)
  })

  it('ignores an assistant message that has no text yet', () => {
    expect(shouldRestorePromptOnStop([m('user'), m('assistant', { content: '' })])).toBe(true)
    expect(shouldRestorePromptOnStop([m('user'), m('assistant', { content: '  \n' })])).toBe(true)
    expect(shouldRestorePromptOnStop([m('user'), m('status'), m('info')])).toBe(true)
  })

  it('does not restore once the turn produced assistant text', () => {
    expect(shouldRestorePromptOnStop([m('user'), m('assistant', { content: 'Working on it' })])).toBe(false)
  })

  it('does not restore once the turn made a tool call', () => {
    expect(shouldRestorePromptOnStop([m('user'), m('tool')])).toBe(false)
  })

  it('measures from the last user message that is not queued', () => {
    expect(shouldRestorePromptOnStop([m('user'), m('assistant', { content: 'done' }), m('user'), m('user', { isQueued: true })])).toBe(true)
    expect(shouldRestorePromptOnStop([m('user'), m('tool'), m('user', { isQueued: true })])).toBe(false)
  })

  it('has nothing to restore without a sent user message', () => {
    expect(shouldRestorePromptOnStop([])).toBe(false)
    expect(shouldRestorePromptOnStop([m('user', { isQueued: true })])).toBe(false)
  })
})
