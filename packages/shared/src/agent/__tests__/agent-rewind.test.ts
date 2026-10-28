import { describe, expect, it } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { PiAgent } from '../pi-agent.ts'
import { createPushableInputStream } from '../backend/claude/persistent-input.ts'

const CHAIN_UUID = '550e8400-e29b-41d4-a716-446655440000'

// Edit-and-resend rewinds the live conversation in place. Claude arms a one-shot
// `resumeSessionAt` on the SAME SDK session (no fork, so the lineage guard of earlier anchors
// stays valid); Pi moves the live session leaf through an RPC.
describe('ClaudeAgent.rewindToTurn', () => {
  function agentWithSession(sessionId: string | null) {
    const agent = Object.create(ClaudeAgent.prototype) as any
    agent.sessionId = sessionId
    agent.rewindToSdkTurnId = null
    agent.branchFromSdkSessionId = null
    agent.branchFromSdkCwd = null
    agent.branchFromSdkTurnId = null
    agent.pendingSteers = { pause: () => {} }
    agent.config = { onSdkSessionIdCleared: () => { agent.cleared = (agent.cleared ?? 0) + 1 } }
    return agent
  }

  it('arms a one-shot cutoff on the same SDK session when an anchor is given', async () => {
    const agent = agentWithSession('sdk-1')
    await expect(agent.rewindToTurn(CHAIN_UUID)).resolves.toBe(true)
    expect(agent.rewindToSdkTurnId).toBe(CHAIN_UUID)
    expect(agent.sessionId).toBe('sdk-1')
    expect(agent.cleared).toBeUndefined()
  })

  it('starts a fresh SDK session when rewinding before the first message', async () => {
    const agent = agentWithSession('sdk-1')
    await expect(agent.rewindToTurn(null)).resolves.toBe(true)
    expect(agent.sessionId).toBeNull()
    expect(agent.rewindToSdkTurnId).toBeNull()
    expect(agent.cleared).toBe(1)
  })

  it('reports false (host reseeds) when no SDK session exists yet', async () => {
    const agent = agentWithSession(null)
    await expect(agent.rewindToTurn(CHAIN_UUID)).resolves.toBe(false)
    expect(agent.rewindToSdkTurnId).toBeNull()
  })

  it('tears down the live keep-alive query so the next turn builds a fresh one', async () => {
    const agent = agentWithSession('sdk-1')
    agent.persistentInput = createPushableInputStream()
    agent.currentQuery = {}
    await agent.rewindToTurn(CHAIN_UUID)
    expect(agent.persistentInput).toBeNull()
    expect(agent.currentQuery).toBeNull()
  })
})

describe('PiAgent.rewindToTurn', () => {
  function piAgent(piSessionId: string | null) {
    const agent = Object.create(PiAgent.prototype) as any
    agent.piSessionId = piSessionId
    agent.subprocess = piSessionId ? {} : null
    agent.pendingRewinds = new Map()
    agent.pendingPermissions = new Map()
    agent.pendingToolExecutions = new Map()
    agent.pendingCompactions = new Map()
    agent.sent = []
    agent.cancelPendingCompactions = () => {}
    agent.emitAutomationEvent = () => {}
    agent.forceAbort = () => {}
    agent.ensureSubprocess = async () => {}
    agent.rpcIdCounter = 0
    agent.send = (cmd: Record<string, unknown>) => { agent.sent.push(cmd) }
    return agent
  }

  it('sends rewind_to_turn with the anchor and resolves on success', async () => {
    const agent = piAgent('pi-1')
    const done = agent.rewindToTurn('entry-7')
    await Promise.resolve()
    await Promise.resolve()
    expect(agent.sent).toHaveLength(1)
    expect(agent.sent[0]).toMatchObject({ type: 'rewind_to_turn', anchorId: 'entry-7' })
    agent.pendingRewinds.get(agent.sent[0].id).resolve()
    await expect(done).resolves.toBe(true)
  })

  it('rejects when the subprocess reports the anchor unusable', async () => {
    const agent = piAgent('pi-1')
    const done = agent.rewindToTurn('missing')
    await Promise.resolve()
    await Promise.resolve()
    agent.pendingRewinds.get(agent.sent[0].id).reject(new Error('Rewind anchor not found: missing'))
    await expect(done).rejects.toThrow('anchor not found')
  })

  it('reports false (host reseeds) when there is no Pi session yet', async () => {
    const agent = piAgent(null)
    await expect(agent.rewindToTurn('entry-7')).resolves.toBe(false)
    expect(agent.sent).toHaveLength(0)
  })
})
