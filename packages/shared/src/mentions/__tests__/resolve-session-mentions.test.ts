/**
 * Tests for formatSessionMention, resolveSessionMentions and session parsing —
 * [session:id] mentions and [session:id:messageId] quotes become semantic
 * markers that point the agent at the get_session_messages tool.
 */
import { describe, it, expect } from 'bun:test'
import { formatSessionMention, parseMentions, resolveSessionMentions } from '../index.ts'

const SESSION_ID = '261028-apt-mountain'
const MESSAGE_ID = 'msg-1793413275096-1s7ahh'

describe('formatSessionMention', () => {
  it('builds a mention token without a message ID', () => {
    expect(formatSessionMention(SESSION_ID)).toBe(`[session:${SESSION_ID}]`)
  })

  it('builds a quote token with a message ID', () => {
    expect(formatSessionMention(SESSION_ID, MESSAGE_ID)).toBe(`[session:${SESSION_ID}:${MESSAGE_ID}]`)
  })
})

describe('resolveSessionMentions', () => {
  it('resolves a session mention', () => {
    expect(resolveSessionMentions(`continue from [session:${SESSION_ID}] please`))
      .toBe(`continue from [Mentioned session: ${SESSION_ID}] please`)
  })

  it('resolves a quote', () => {
    expect(resolveSessionMentions(`[session:${SESSION_ID}:${MESSAGE_ID}] is this right?`))
      .toBe(`[Quoted session: ${SESSION_ID}, from message ${MESSAGE_ID}] is this right?`)
  })

  it('resolves multiple tokens in one message', () => {
    expect(resolveSessionMentions('[session:a-1] vs [session:b-2:msg-3]'))
      .toBe('[Mentioned session: a-1] vs [Quoted session: b-2, from message msg-3]')
  })

  it('round-trips tokens built by formatSessionMention', () => {
    expect(resolveSessionMentions(formatSessionMention(SESSION_ID, MESSAGE_ID)))
      .toBe(`[Quoted session: ${SESSION_ID}, from message ${MESSAGE_ID}]`)
  })

  it('leaves other mention types and malformed tokens untouched', () => {
    const text = '[skill:commit] [source:github] [file:a.ts] [session:] [session:a b] [session:a:b:c]'
    expect(resolveSessionMentions(text)).toBe(text)
  })
})

describe('parseMentions sessions', () => {
  it('collects session IDs from mentions and quotes, deduplicated', () => {
    const text = `[session:${SESSION_ID}] [session:${SESSION_ID}:${MESSAGE_ID}] [session:other-1]`
    expect(parseMentions(text, [], []).sessions).toEqual([SESSION_ID, 'other-1'])
  })

  it('returns no sessions when none are mentioned', () => {
    expect(parseMentions('[source:github]', [], ['github']).sessions).toEqual([])
  })
})
