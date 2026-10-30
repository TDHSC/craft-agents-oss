import { describe, expect, it } from 'bun:test'
import { RESUMABLE_ERROR_CODES, getResumableStop, type ResumableStopMessage } from '../resumable-stop.ts'

const m = (role: string, extra: Partial<ResumableStopMessage> = {}): ResumableStopMessage => ({ role, ...extra })

describe('getResumableStop', () => {
  it('is null for an empty or all-hidden conversation', () => {
    expect(getResumableStop([])).toBeNull()
    expect(getResumableStop([m('user', { hidden: true })])).toBeNull()
  })

  for (const code of RESUMABLE_ERROR_CODES) {
    it(`resumes after a ${code} error`, () => {
      expect(getResumableStop([m('user'), m('error', { errorCode: code })])).toEqual({ reason: 'error', errorCode: code })
    })
  }

  it('carries the reset time of a rate-limit error', () => {
    expect(getResumableStop([m('error', { errorCode: 'rate_limited', errorResetAt: 1_700_000_000_000 })])).toEqual({
      reason: 'error',
      errorCode: 'rate_limited',
      errorResetAt: 1_700_000_000_000,
    })
  })

  it('reports an output_truncated error as truncated', () => {
    expect(getResumableStop([m('assistant'), m('error', { errorCode: 'output_truncated' })])).toEqual({
      reason: 'truncated',
      errorCode: 'output_truncated',
    })
  })

  const NOT_RESUMABLE = [
    'invalid_api_key', 'invalid_credentials', 'expired_oauth_token', 'token_expired', 'billing_error',
    'invalid_model', 'invalid_request', 'model_no_tool_support', 'image_too_large', 'unknown_error', undefined,
  ]
  for (const code of NOT_RESUMABLE) {
    it(`does not resume after a ${code} error, where continuing would fail the same way`, () => {
      expect(getResumableStop([m('user'), m('error', { errorCode: code })])).toBeNull()
    })
  }

  it('resumes after a user Stop', () => {
    expect(getResumableStop([m('user'), m('info', { statusType: 'interrupted' })])).toEqual({ reason: 'stopped' })
  })

  it('ignores other info rows', () => {
    expect(getResumableStop([m('user'), m('info', { statusType: 'compaction_complete' })])).toBeNull()
    expect(getResumableStop([m('user'), m('info')])).toBeNull()
  })

  it('treats a trailing user or tool message as cut off', () => {
    expect(getResumableStop([m('assistant'), m('user')])).toEqual({ reason: 'cut_off' })
    expect(getResumableStop([m('user'), m('assistant'), m('tool')])).toEqual({ reason: 'cut_off' })
  })

  it('is null when the turn ended with a reply', () => {
    expect(getResumableStop([m('user'), m('assistant')])).toBeNull()
  })

  it('is null after a plan or an auth request', () => {
    expect(getResumableStop([m('user'), m('plan')])).toBeNull()
    expect(getResumableStop([m('user'), m('auth-request')])).toBeNull()
  })

  it('looks past hidden messages to the last visible one', () => {
    expect(getResumableStop([
      m('error', { errorCode: 'rate_limited' }),
      m('user', { hidden: true }),
    ])).toEqual({ reason: 'error', errorCode: 'rate_limited' })
    expect(getResumableStop([m('user'), m('assistant'), m('user', { hidden: true })])).toBeNull()
  })

  it('only judges the last visible message', () => {
    expect(getResumableStop([m('error', { errorCode: 'rate_limited' }), m('user'), m('assistant')])).toBeNull()
  })
})
