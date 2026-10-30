import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// continueTurn: ▶ / Retry / auto-continue send one hidden "Continue where you left off." when
// `getResumableStop` says the session stopped abnormally.
describe('continueTurn', () => {
  let tmpRoot: string
  let sm: SessionManager
  let sent: Array<{ sessionId: string; message: string; options: any }>

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-continue-turn-'))
    sm = new SessionManager()
    sent = []
    ;(sm as any).sendEvent = () => {}
    ;(sm as any).persistSession = () => {}
    ;(sm as any).sendMessage = mock(async (sessionId: string, message: string, _a: unknown, _s: unknown, options: unknown) => {
      sent.push({ sessionId, message, options })
    })
  })

  afterEach(() => {
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const msg = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role, content: id, timestamp: 1, ...extra })

  function buildSession(messages: unknown[], overrides: Record<string, unknown> = {}) {
    const workspace = { id: 'ws-test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id: 's1', name: 'continue test' }, workspace as never, { messagesLoaded: true, ...overrides })
    managed.messages = messages as never
    ;(sm as any).sessions.set('s1', managed)
    return managed
  }

  const stoppedByUser = () => [msg('u1', 'user'), msg('a1', 'assistant'), msg('i1', 'info', { statusType: 'interrupted' })]

  it('sends one hidden, labelled notice for a resumable stop', async () => {
    buildSession(stoppedByUser())

    expect(await sm.continueTurn('s1')).toBe(true)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.sessionId).toBe('s1')
    expect(sent[0]!.message).toContain('<system-notification>')
    expect(sent[0]!.message).toContain('Continue where you left off.')
    expect(sent[0]!.options).toEqual({ hidden: true, continueTrigger: 'user' })
  })

  it('passes the trigger on', async () => {
    buildSession(stoppedByUser())
    await sm.continueTurn('s1', 'auto')
    expect(sent[0]!.options.continueTrigger).toBe('auto')
  })

  it('is refused while the session is processing', async () => {
    buildSession(stoppedByUser(), { isProcessing: true })
    expect(await sm.continueTurn('s1')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('is refused for an unknown session', async () => {
    expect(await sm.continueTurn('missing')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('is refused when nothing can be resumed', async () => {
    buildSession([msg('u1', 'user'), msg('a1', 'assistant')])
    expect(await sm.continueTurn('s1')).toBe(false)
    buildSession([msg('u1', 'user'), msg('e1', 'error', { errorCode: 'invalid_api_key' })])
    expect(await sm.continueTurn('s1')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('continues after a resumable typed error and after a truncated reply', async () => {
    buildSession([msg('u1', 'user'), msg('e1', 'error', { errorCode: 'rate_limited' })])
    expect(await sm.continueTurn('s1')).toBe(true)
    buildSession([msg('u1', 'user'), msg('e1', 'error', { errorCode: 'output_truncated' })])
    expect(await sm.continueTurn('s1')).toBe(true)
  })

  it('clears wasInterrupted so the turn does not carry the "do not continue" reminder', async () => {
    const managed = buildSession(stoppedByUser(), { wasInterrupted: true })
    await sm.continueTurn('s1')
    expect(managed.wasInterrupted).toBe(false)
  })

  it('offers a continue after a user Stop, because Stop marks its info row as interrupted', async () => {
    const managed = buildSession([msg('u1', 'user'), msg('a1', 'assistant')], { isProcessing: true })
    await sm.cancelProcessing('s1')
    expect(managed.messages.at(-1)).toMatchObject({ role: 'info', content: 'Response interrupted', statusType: 'interrupted' })

    managed.isProcessing = false
    expect(await sm.continueTurn('s1')).toBe(true)
  })

  it('leaves wasInterrupted alone when it refuses', async () => {
    const managed = buildSession([msg('u1', 'user'), msg('a1', 'assistant')], { wasInterrupted: true })
    await sm.continueTurn('s1')
    expect(managed.wasInterrupted).toBe(true)
  })
})

// The hidden notice counts as a turn from the user only for a manual continue (TaskRunner treats
// `fromUser` turns like typed messages).
describe('sendMessage turnFromUser for continue notices', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-continue-from-user-'))
    sm = new SessionManager()
    ;(sm as any).sendEvent = () => {}
    ;(sm as any).persistSession = () => {}
    // Stop right after turnFromUser is set; the rest of sendMessage needs a real agent.
    ;(sm as any).ensureMessagesLoaded = async () => { throw new Error('stop here') }
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  async function turnFromUser(options: Record<string, unknown>) {
    const workspace = { id: 'ws-test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id: 's1', name: 'from user' }, workspace as never, { messagesLoaded: true })
    ;(sm as any).sessions.set('s1', managed)
    await expect(sm.sendMessage('s1', 'x', [], [], options as never)).rejects.toThrow('stop here')
    return managed.turnFromUser
  }

  it('is true for a plain message and for a user-triggered continue', async () => {
    expect(await turnFromUser({})).toBe(true)
    expect(await turnFromUser({ hidden: true, continueTrigger: 'user' })).toBe(true)
  })

  it('is false for other hidden messages and for an auto-continue', async () => {
    expect(await turnFromUser({ hidden: true })).toBe(false)
    expect(await turnFromUser({ hidden: true, continueTrigger: 'auto' })).toBe(false)
  })
})
