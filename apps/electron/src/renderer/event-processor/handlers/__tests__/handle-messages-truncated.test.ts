import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { SessionState } from '../../types'

function makeState(): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [
        { id: 'u1', role: 'user', content: 'one', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'reply', timestamp: 2 },
        { id: 'u2', role: 'user', content: 'two', timestamp: 3 },
        { id: 'a2', role: 'assistant', content: 'partial', timestamp: 4, isStreaming: true },
      ],
      lastMessageAt: 4,
      isProcessing: true,
    } as any,
    streaming: { content: 'partial', turnId: 't1', parentToolUseId: undefined } as any,
  }
}

describe('messages_truncated', () => {
  it('removes exactly the named messages and drops the stale streaming buffer', () => {
    const next = processEvent(makeState(), {
      type: 'messages_truncated',
      sessionId: 'session-1',
      removedMessageIds: ['u2', 'a2'],
    })
    expect(next.state.session.messages.map(m => m.id)).toEqual(['u1', 'a1'])
    expect(next.state.streaming).toBeNull()
    expect(next.effects).toEqual([])
  })

  it('ignores ids it does not have', () => {
    const next = processEvent(makeState(), {
      type: 'messages_truncated',
      sessionId: 'session-1',
      removedMessageIds: ['nope'],
    })
    expect(next.state.session.messages).toHaveLength(4)
  })
})
