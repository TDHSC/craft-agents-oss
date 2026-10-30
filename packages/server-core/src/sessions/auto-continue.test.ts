import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from './SessionManager.ts'

// Auto-continue at the quota reset: a rate-limit error that says when it ends arms one timer per
// session (setting `autoContinueAfterLimitReset`, off by default); firing runs the guards and then
// `continueTurn(…, 'auto')`. After a restart (`autoContinueAfterRestart`, also off by default) the
// same guards continue the turns an app exit cut off.
//
// Timers are recorded instead of run: this Bun has no `jest.advanceTimersByTime`.
interface FakeTimer { fn: () => void; delay: number; cleared: boolean; fired: boolean; unref: () => void }

describe('auto-continue at the quota reset', () => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  let timers: FakeTimer[]
  let tmpRoot: string
  let sm: SessionManager
  let sent: Array<{ message: string; options: any }>
  let toggle: boolean
  let restartToggle: boolean
  const NOW = 1_800_000_000_000

  beforeEach(() => {
    timers = []
    globalThis.setTimeout = ((fn: () => void, delay = 0) => {
      const timer: FakeTimer = { fn, delay, cleared: false, fired: false, unref() {} }
      timers.push(timer)
      return timer
    }) as unknown as typeof setTimeout
    globalThis.clearTimeout = ((timer?: FakeTimer) => { if (timer) timer.cleared = true }) as unknown as typeof clearTimeout

    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-auto-continue-'))
    sm = new SessionManager()
    sent = []
    toggle = true
    restartToggle = true
    ;(sm as any).sendEvent = () => {}
    ;(sm as any).persistSession = () => {}
    ;(sm as any).autoContinueAfterLimitReset = () => toggle
    ;(sm as any).autoContinueAfterRestart = () => restartToggle
    ;(sm as any).sendMessage = mock(async (_id: string, message: string, _a: unknown, _s: unknown, options: unknown) => {
      sent.push({ message, options })
    })
  })

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    mock.restore()
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  const live = () => timers.filter(t => !t.cleared && !t.fired)
  const runTimer = (timer: FakeTimer) => { timer.fired = true; timer.fn() }
  const settle = () => new Promise<void>(resolve => realSetTimeout(resolve, 0))
  const msg = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, role, content: id, timestamp: 1, ...extra })
  const rateLimited = (id = 'e1', extra: Record<string, unknown> = {}) => msg(id, 'error', { errorCode: 'rate_limited', ...extra })

  function buildSession(overrides: Record<string, unknown> = {}, messages: unknown[] = [msg('u1', 'user'), rateLimited()], id = 's1') {
    const workspace = { id: 'ws-test', name: 'Test', rootPath: tmpRoot, createdAt: Date.now() }
    const managed = createManagedSession({ id, name: 'auto continue' }, workspace as never, { messagesLoaded: true, ...overrides })
    managed.messages = messages as never
    ;(sm as any).sessions.set(id, managed)
    return managed
  }

  async function rateLimitError(managed: any, originalError: string) {
    managed.isProcessing = true
    await (sm as any).processEvent(managed, {
      type: 'typed_error',
      error: { code: 'rate_limited', title: 'Rate Limited', message: 'Rate limit reached. Retries did not succeed.', actions: [], canRetry: true, originalError },
    })
  }

  const QUOTA_ERROR = '429 Individual quota reached for this model. Resets in 40h1m10s'
  const lastMessage = (managed: any) => managed.messages.at(-1)

  describe('arming', () => {
    it('arms one timer at the reset time and records it on the error and the session', async () => {
      const dateNow = Date.now
      Date.now = () => NOW
      try {
        const managed = buildSession({}, [msg('u1', 'user')])
        await rateLimitError(managed, QUOTA_ERROR)

        const resetAt = NOW + (40 * 3600 + 60 + 10) * 1000
        expect(lastMessage(managed).errorResetAt).toBe(resetAt)
        expect(lastMessage(managed).content).toContain('Resets at')
        expect(managed.autoContinueAt).toBe(resetAt + 5_000)
        expect(live()).toHaveLength(1)
        expect(live()[0]!.delay).toBe(resetAt + 5_000 - NOW)
      } finally {
        Date.now = dateNow
      }
    })

    it('still records the reset time, but arms nothing, while the setting is off', async () => {
      toggle = false
      const managed = buildSession({}, [msg('u1', 'user')])
      await rateLimitError(managed, QUOTA_ERROR)

      expect(lastMessage(managed).errorResetAt).toBeGreaterThan(Date.now())
      expect(managed.autoContinueAt).toBeUndefined()
      expect(live()).toHaveLength(0)
    })

    it('arms nothing when the text has no reset time', async () => {
      const managed = buildSession({}, [msg('u1', 'user')])
      await rateLimitError(managed, '429 Too many requests')

      expect(lastMessage(managed).errorResetAt).toBeUndefined()
      expect(managed.autoContinueAt).toBeUndefined()
      expect(live()).toHaveLength(0)
    })

    it('arms nothing for a session nobody attends', async () => {
      const managed = buildSession({ unattended: true }, [msg('u1', 'user')])
      await rateLimitError(managed, QUOTA_ERROR)
      expect(live()).toHaveLength(0)
      const task = buildSession({ taskSlug: 'nightly' }, [msg('u1', 'user')], 's2')
      await rateLimitError(task, QUOTA_ERROR)
      expect(live()).toHaveLength(0)
    })
  })

  describe('firing', () => {
    async function armed() {
      const managed = buildSession({ autoContinueAt: Date.now() + 60_000 })
      ;(sm as any).armAutoContinue(managed)
      expect(live()).toHaveLength(1)
      return managed
    }

    it('continues the turn as an auto-continue and clears the pending time', async () => {
      const managed = await armed()
      runTimer(live()[0]!)
      await settle()

      expect(sent).toHaveLength(1)
      expect(sent[0]!.message).toContain('Continue where you left off.')
      expect(sent[0]!.options).toEqual({ hidden: true, continueTrigger: 'auto' })
      expect(managed.autoContinueAt).toBeUndefined()
    })

    it('is cancelled by a message the user sends', async () => {
      const managed = await armed()
      // The real sendMessage, stopped right after it cancels (the rest needs a live agent).
      ;(sm as any).sendMessage = SessionManager.prototype.sendMessage.bind(sm)
      ;(sm as any).ensureMessagesLoaded = async () => { throw new Error('stop here') }
      await expect(sm.sendMessage('s1', 'hello', [], [], {})).rejects.toThrow('stop here')

      expect(managed.autoContinueAt).toBeUndefined()
      expect(live()).toHaveLength(0)
    })

    it('is not cancelled by another hidden message', async () => {
      const managed = await armed()
      ;(sm as any).sendMessage = SessionManager.prototype.sendMessage.bind(sm)
      ;(sm as any).ensureMessagesLoaded = async () => { throw new Error('stop here') }
      await expect(sm.sendMessage('s1', 'nudge', [], [], { hidden: true })).rejects.toThrow('stop here')

      expect(managed.autoContinueAt).toBeDefined()
      expect(live()).toHaveLength(1)
    })

    it('does nothing when the setting was turned off meanwhile', async () => {
      await armed()
      toggle = false
      runTimer(live()[0]!)
      await settle()
      expect(sent).toHaveLength(0)
    })

    it('does nothing for an archived, busy or unattended session', async () => {
      for (const flags of [{ isArchived: true }, { isProcessing: true }, { unattended: true }, { hidden: true }, { taskRunId: 'run-1' }]) {
        sent.length = 0
        const managed = buildSession({ autoContinueAt: Date.now() + 1_000, ...flags })
        ;(sm as any).armAutoContinue(managed)
        runTimer(live().at(-1)!)
        await settle()
        expect(sent).toHaveLength(0)
      }
    })

    it('does nothing once the session is no longer stopped', async () => {
      const managed = buildSession({ autoContinueAt: Date.now() + 1_000 }, [msg('u1', 'user'), rateLimited(), msg('u2', 'user'), msg('a1', 'assistant')])
      ;(sm as any).armAutoContinue(managed)
      runTimer(live()[0]!)
      await settle()
      expect(sent).toHaveLength(0)
    })

    it('stops after three auto-continues within five minutes, then allows one again', async () => {
      const dateNow = Date.now
      let now = NOW
      Date.now = () => now
      try {
        buildSession()
        const fire = async () => { sent.length = 0; await (sm as any).fireAutoContinue('s1'); return sent.length }
        expect(await fire()).toBe(1)
        expect(await fire()).toBe(1)
        expect(await fire()).toBe(1)
        expect(await fire()).toBe(0)
        now += 5 * 60 * 1000 + 1
        expect(await fire()).toBe(1)
      } finally {
        Date.now = dateNow
      }
    })
  })

  describe('startup', () => {
    it('re-arms a pending auto-continue from the session header', () => {
      const managed = buildSession({ autoContinueAt: Date.now() + 90_000 })
      buildSession({}, [msg('u1', 'user'), rateLimited()], 's2')
      ;(sm as any).rearmAutoContinues()

      expect(live()).toHaveLength(1)
      expect(live()[0]!.delay).toBeGreaterThan(80_000)
      expect(managed.autoContinueAt).toBeDefined()
    })

    it('fires one that is already due at once', async () => {
      buildSession({ autoContinueAt: Date.now() - 60_000 })
      ;(sm as any).rearmAutoContinues()

      expect(live()[0]!.delay).toBe(0)
      runTimer(live()[0]!)
      await settle()
      expect(sent).toHaveLength(1)
    })

    it('skips a reset more than a timer can wait for', () => {
      buildSession({ autoContinueAt: Date.now() + 2 ** 31 + 1_000 })
      ;(sm as any).rearmAutoContinues()
      expect(live()).toHaveLength(0)
    })
  })

  describe('after an app restart', () => {
    const cutOff = [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')]
    const restart = async () => { await (sm as any).continueCutOffTurns() }

    it('continues a turn cut off with the last message from the user or a tool', async () => {
      buildSession({ lastMessageRole: 'user' }, cutOff, 'a')
      buildSession({ lastMessageRole: 'tool' }, [msg('u1', 'user'), msg('t1', 'tool')], 'b')
      await restart()

      expect(sent).toHaveLength(2)
      expect(sent.every(s => s.options.continueTrigger === 'auto' && s.options.hidden === true)).toBe(true)
    })

    it('continues only a cut-off turn, not other stops or finished ones', async () => {
      buildSession({ lastMessageRole: 'assistant' }, [msg('u1', 'user'), msg('a1', 'assistant')], 'replied')
      // The header says error, but the loaded messages decide: a typed error is not a cut-off turn
      buildSession({ lastMessageRole: 'error' }, [msg('u1', 'user'), rateLimited()], 'errored')
      buildSession({}, [msg('u1', 'user'), msg('i1', 'info', { statusType: 'interrupted' })], 'stopped')
      buildSession({ lastMessageRole: 'plan' }, [msg('u1', 'user'), msg('p1', 'plan')], 'plan')
      await restart()
      expect(sent).toHaveLength(0)
    })

    it('does not load the messages of a session whose header says it replied', async () => {
      const managed = buildSession({ lastMessageRole: 'assistant', messagesLoaded: false }, cutOff, 'replied')
      const loaded = mock(async () => {})
      ;(sm as any).ensureMessagesLoaded = loaded
      await restart()
      expect(loaded).not.toHaveBeenCalled()
      expect(managed.messagesLoaded).toBe(false)
    })

    it('ignores sessions outside the 24 hour window', async () => {
      buildSession({ lastMessageRole: 'user', lastMessageAt: Date.now() - 25 * 3600 * 1000 }, cutOff, 'old')
      buildSession({ lastMessageRole: 'user', lastMessageAt: Date.now() - 23 * 3600 * 1000 }, cutOff, 'recent')
      await restart()
      expect(sent).toHaveLength(1)
    })

    it('leaves task, automation, hidden, unattended and archived sessions alone', async () => {
      const header = { lastMessageRole: 'user' }
      buildSession({ ...header, taskSlug: 'nightly' }, cutOff, 'task')
      buildSession({ ...header, taskRunId: 'run-1' }, cutOff, 'task-child')
      buildSession({ ...header, triggeredBy: { automationName: 'daily' } }, cutOff, 'automation')
      buildSession({ ...header, hidden: true }, cutOff, 'hidden')
      buildSession({ ...header, unattended: true }, cutOff, 'unattended')
      buildSession({ ...header, isArchived: true }, cutOff, 'archived')
      await restart()
      expect(sent).toHaveLength(0)
    })

    it('leaves a session whose queued messages replay to that replay', async () => {
      const managed = buildSession({ lastMessageRole: 'user' }, [msg('u1', 'user'), msg('u2', 'user', { isQueued: true })], 'queued')
      managed.messageQueue.push({ message: 'u2', messageId: 'u2', options: undefined } as never)
      await restart()
      expect(sent).toHaveLength(0)
    })

    it('does nothing while the setting is off', async () => {
      restartToggle = false
      buildSession({ lastMessageRole: 'user' }, cutOff)
      await restart()
      expect(sent).toHaveLength(0)
    })

    it('is a separate setting from the quota-reset one', async () => {
      toggle = false
      buildSession({ lastMessageRole: 'user' }, cutOff)
      await restart()
      expect(sent).toHaveLength(1)
    })

    it('skips a busy session and keeps to the three-in-five-minutes cap', async () => {
      buildSession({ lastMessageRole: 'user', isProcessing: true }, cutOff, 'busy')
      await restart()
      expect(sent).toHaveLength(0)

      buildSession({ lastMessageRole: 'user' }, cutOff, 'ok')
      for (let i = 0; i < 5; i++) await restart()
      expect(sent).toHaveLength(3)
    })
  })

  it('clears every timer on cleanup', () => {
    const managed = buildSession({ autoContinueAt: Date.now() + 60_000 })
    ;(sm as any).armAutoContinue(managed)
    sm.cleanup()
    expect(live()).toHaveLength(0)
  })
})
