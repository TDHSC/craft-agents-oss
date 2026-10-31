import { describe, it, expect } from 'bun:test'
import type { Message } from '../../../shared/types'
import { getQuoteAnchorMessageId } from '../session'

const msg = (id: string, role: Message['role'], extra: Partial<Message> = {}) =>
  ({ id, role, content: '', timestamp: 0, ...extra }) as Message

describe('getQuoteAnchorMessageId', () => {
  it('anchors at the user message that triggered the reply', () => {
    const messages = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('t1', 'tool'), msg('a2', 'assistant')]
    expect(getQuoteAnchorMessageId(messages, 'a2')).toBe('u2')
    expect(getQuoteAnchorMessageId(messages, 'a1')).toBe('u1')
  })

  it('skips hidden user messages', () => {
    const messages = [msg('u1', 'user'), msg('u2', 'user', { hidden: true }), msg('a1', 'assistant')]
    expect(getQuoteAnchorMessageId(messages, 'a1')).toBe('u1')
  })

  it('falls back to the reply itself when no user message precedes it', () => {
    expect(getQuoteAnchorMessageId([msg('a1', 'assistant'), msg('u1', 'user')], 'a1')).toBe('a1')
    expect(getQuoteAnchorMessageId([msg('a1', 'assistant')], 'missing')).toBe('missing')
  })
})
