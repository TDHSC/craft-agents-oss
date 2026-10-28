import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession, removeTurnAnchors } from './SessionManager.ts'

// Edit-and-resend (`SendMessageOptions.replaceMessageId`): drop the replaced message and everything
// after it, rewind the SDK conversation in place, and re-send the new content.
describe('applyReplaceMessage', () => {
  let tmpRoot: string
  let sm: SessionManager
  let events: any[]

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-edit-resend-'))
    sm = new SessionManager()
    events = []
    ;(sm as any).sendEvent = (event: unknown) => { events.push(event) }
    ;(sm as any).persistSession = () => {}
    ;(sm as any).flushSession = async () => {}
    ;(sm as any).onProcessingStopped = mock(async (id: string) => {
      const m = (sm as any).sessions.get(id)
      m.isProcessing = false
    })
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function conversation() {
    const msg = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role, content: id, timestamp: 1, ...extra })
    return [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant'), msg('u3', 'user')]
  }

  function buildSession(overrides: Record<string, unknown> = {}) {
    const workspace = { id: 'ws-test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id: 's1', name: 'edit test' }, workspace as never, {
      messagesLoaded: true,
      sdkSessionId: 'sdk-1',
      ...overrides,
    })
    managed.messages = conversation() as never
    ;(sm as any).sessions.set('s1', managed)
    return managed
  }

  function fakeAgent(result: boolean | Error = true) {
    const calls: Array<string | null> = []
    return {
      calls,
      rewindToTurn: async (anchor: string | null) => {
        calls.push(anchor)
        if (result instanceof Error) throw result
        return result
      },
      forceAbort: () => {},
    }
  }

  it('truncates at the replaced message and rewinds to the previous reply anchor', async () => {
    const managed = buildSession()
    const agent = fakeAgent()
    managed.agent = agent as never
    ;(sm as any).lookupRewindAnchor = async (_m: unknown, _p: string, id: string) => (id === 'a1' ? 'anchor-a1' : undefined)

    await (sm as any).applyReplaceMessage(managed, 'u2')

    expect(managed.messages.map(m => m.id)).toEqual(['u1', 'a1'])
    expect(agent.calls).toEqual(['anchor-a1'])
    expect(managed.rewindSeedPending).toBeFalsy()
    expect(events).toContainEqual({ type: 'messages_truncated', sessionId: 's1', removedMessageIds: ['u2', 'a2', 'u3'] })
  })

  it('rewinds before the first message when the first message is edited', async () => {
    const managed = buildSession()
    const agent = fakeAgent()
    managed.agent = agent as never

    await (sm as any).applyReplaceMessage(managed, 'u1')

    expect(managed.messages).toEqual([])
    expect(agent.calls).toEqual([null])
    expect(managed.rewindSeedPending).toBeFalsy()
  })

  it('resets the SDK conversation and reseeds when the kept reply has no usable anchor', async () => {
    const managed = buildSession()
    const agent = fakeAgent()
    managed.agent = agent as never
    ;(sm as any).lookupRewindAnchor = async () => undefined

    await (sm as any).applyReplaceMessage(managed, 'u3')

    expect(agent.calls).toEqual([null])
    expect(managed.rewindSeedPending).toBe(true)
    expect(managed.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })

  it('does not trust the anchor of an earlier reply when a later user message went unanswered', async () => {
    const managed = buildSession()
    managed.messages = [...conversation().slice(0, 2), { id: 'u2', role: 'user', content: 'x', timestamp: 2 }, { id: 'u3', role: 'user', content: 'y', timestamp: 3 }] as never
    const agent = fakeAgent()
    managed.agent = agent as never
    ;(sm as any).lookupRewindAnchor = async () => 'anchor-a1'

    await (sm as any).applyReplaceMessage(managed, 'u3')

    expect(agent.calls).toEqual([null])
    expect(managed.rewindSeedPending).toBe(true)
  })

  it('falls back to reset + seed when the native rewind is rejected', async () => {
    const managed = buildSession()
    let n = 0
    const calls: Array<string | null> = []
    managed.agent = {
      rewindToTurn: async (anchor: string | null) => {
        calls.push(anchor)
        if (n++ === 0) throw new Error('anchor not found')
        return true
      },
      forceAbort: () => {},
    } as never
    ;(sm as any).lookupRewindAnchor = async () => 'stale'

    await (sm as any).applyReplaceMessage(managed, 'u2')

    expect(calls).toEqual(['stale', null])
    expect(managed.rewindSeedPending).toBe(true)
  })

  it('hard-stops a running turn silently: new generation, no interruption note, state reset', async () => {
    const managed = buildSession({ wasInterrupted: true })
    managed.isProcessing = true
    managed.processingGeneration = 4
    managed.stopEpoch = 2
    managed.messageQueue = [{ message: 'q', messageId: 'q1' } as never]
    managed.messages.push({ id: 'q1', role: 'user', content: 'q', timestamp: 9, isQueued: true } as never)
    managed.agent = fakeAgent() as never
    ;(sm as any).lookupRewindAnchor = async () => 'anchor-a2'

    await (sm as any).applyReplaceMessage(managed, 'u3')

    expect(managed.processingGeneration).toBe(5)
    expect(managed.stopEpoch).toBe(3)
    expect(managed.wasInterrupted).toBe(false)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect((sm as any).onProcessingStopped).toHaveBeenCalledWith('s1', 'interrupted')
    // "Response interrupted" is only for an explicit Stop
    expect(managed.messages.some(m => m.role === 'info')).toBe(false)
  })

  it('replaces a queued message without interrupting the running turn', async () => {
    const managed = buildSession()
    managed.isProcessing = true
    managed.processingGeneration = 4
    managed.messages.push(
      { id: 'q1', role: 'user', content: 'q1', timestamp: 9, isQueued: true } as never,
      { id: 'q2', role: 'user', content: 'q2', timestamp: 10, isQueued: true } as never,
    )
    managed.messageQueue = [{ message: 'q1', messageId: 'q1' } as never, { message: 'q2', messageId: 'q2' } as never]
    const agent = fakeAgent()
    managed.agent = agent as never

    await (sm as any).applyReplaceMessage(managed, 'q1')

    expect(managed.isProcessing).toBe(true)
    expect(managed.processingGeneration).toBe(4)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
    expect(agent.calls).toEqual([])
    expect((sm as any).onProcessingStopped).not.toHaveBeenCalled()
    expect(events).toContainEqual({ type: 'messages_truncated', sessionId: 's1', removedMessageIds: ['q1', 'q2'] })
  })

  it('keeps earlier queue entries when a later queued message is replaced', async () => {
    const managed = buildSession()
    managed.isProcessing = true
    managed.messages.push(
      { id: 'q1', role: 'user', content: 'q1', timestamp: 9, isQueued: true } as never,
      { id: 'q2', role: 'user', content: 'q2', timestamp: 10, isQueued: true } as never,
    )
    managed.messageQueue = [{ message: 'q1', messageId: 'q1' } as never, { message: 'q2', messageId: 'q2' } as never]

    await (sm as any).applyReplaceMessage(managed, 'q2')

    expect(managed.messageQueue.map(q => q.messageId)).toEqual(['q1'])
    expect(managed.messages.map(m => m.id)).toContain('q1')
    expect(managed.messages.map(m => m.id)).not.toContain('q2')
  })

  it('rejects unknown, non-user and hidden targets', async () => {
    const managed = buildSession()
    managed.messages.push({ id: 'h1', role: 'user', content: 'nudge', timestamp: 11, hidden: true } as never)
    await expect((sm as any).applyReplaceMessage(managed, 'nope')).rejects.toThrow('not found')
    await expect((sm as any).applyReplaceMessage(managed, 'a1')).rejects.toThrow('cannot be edited')
    await expect((sm as any).applyReplaceMessage(managed, 'h1')).rejects.toThrow('cannot be edited')
  })

  it('turns an unstarted fork into a seeded fresh session instead of forking the whole parent', async () => {
    const managed = buildSession({
      sdkSessionId: undefined,
      branchFromMessageId: 'a1',
      branchContextStrategy: 'sdk-fork',
      branchFromSdkSessionId: 'parent-sdk',
      branchFromSdkTurnId: 'turn',
    })
    const agent = fakeAgent()
    managed.agent = agent as never

    await (sm as any).applyReplaceMessage(managed, 'u2')

    expect(managed.branchContextStrategy).toBe('seeded-fresh-session')
    expect(managed.branchFromSdkSessionId).toBeUndefined()
    expect(managed.branchSeedApplied).toBe(false)
    expect(agent.calls).toEqual([null])
  })

  it('leaves the transcript intact when even the reset fails, and still resets the processing state', async () => {
    const managed = buildSession()
    managed.isProcessing = true
    managed.agent = { rewindToTurn: async () => { throw new Error('boom') }, forceAbort: () => {} } as never
    ;(sm as any).lookupRewindAnchor = async () => undefined

    await expect((sm as any).applyReplaceMessage(managed, 'u3')).rejects.toThrow('boom')
    expect((sm as any).onProcessingStopped).toHaveBeenCalledWith('s1', 'interrupted')
    expect(managed.messages).toHaveLength(5)
  })
})

describe('removeTurnAnchors', () => {
  it('drops the given messages from both anchor sidecars and keeps the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sm-anchors-'))
    try {
      const sessionPath = join(root, 'session')
      mkdirSync(join(sessionPath, 'meta'), { recursive: true })
      writeFileSync(join(sessionPath, 'meta', 'pi-turn-anchors.json'), JSON.stringify({ version: 1, anchors: { a1: 'p1', a2: 'p2' } }))
      writeFileSync(join(sessionPath, 'meta', 'claude-turn-anchors.json'), JSON.stringify({
        version: 1,
        anchors: {
          a1: { sdkSessionId: 's', sdkMessageUuid: '550e8400-e29b-41d4-a716-446655440000' },
          a2: { sdkSessionId: 's', sdkMessageUuid: '550e8400-e29b-41d4-a716-446655440001' },
        },
      }))

      await removeTurnAnchors(sessionPath, ['a2'])

      expect(Object.keys(JSON.parse(readFileSync(join(sessionPath, 'meta', 'pi-turn-anchors.json'), 'utf-8')).anchors)).toEqual(['a1'])
      expect(Object.keys(JSON.parse(readFileSync(join(sessionPath, 'meta', 'claude-turn-anchors.json'), 'utf-8')).anchors)).toEqual(['a1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('is a no-op when no sidecar exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sm-anchors-'))
    try {
      await removeTurnAnchors(join(root, 'session'), ['a1'])
      expect(existsSync(join(root, 'session'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
