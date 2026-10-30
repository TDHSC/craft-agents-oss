import { describe, expect, it } from 'bun:test'
import { createAgentError, parseError, parseRateLimitResetAt } from '../errors.ts'

describe('parseError proxy interception handling', () => {
  it('maps interceptor proxy marker message to proxy_error', () => {
    const message = 'Received an unexpected HTML error page (HTTP 400) instead of a JSON API response. This may be caused by your network proxy (http://example.com:8080). Check your proxy settings in Settings > Network.'
    const parsed = parseError(new Error(message))

    expect(parsed.code).toBe('proxy_error')
    expect(parsed.message).toBe(message)
  })

  it('maps raw Cloudflare HTML error page to proxy_error with sanitized message', () => {
    const rawHtml = `<html>
<head><title>400 Bad Request</title></head>
<body>
<center><h1>400 Bad Request</h1></center>
<hr><center>cloudflare</center>
</body>
</html>`

    const parsed = parseError(new Error(rawHtml))

    expect(parsed.code).toBe('proxy_error')
    expect(parsed.message).toContain('unexpected HTML error page')
    expect(parsed.message).toContain('HTTP 400')
    expect(parsed.message.toLowerCase()).toContain('proxy settings')
    expect(parsed.message.toLowerCase()).not.toContain('<html')
    expect(parsed.originalError).toBe(rawHtml)
  })

  it('does not remap regular 401 auth errors as proxy_error', () => {
    const parsed = parseError(new Error('401 Unauthorized'))

    expect(parsed.code).toBe('invalid_api_key')
  })
})

describe('parseError tool-support classification', () => {
  // Regression for the misclassification in the screenshot: an Anthropic
  // cache_control TTL ordering error mentioning `tools` in its hint string
  // was being labeled "Model Does Not Support Tools". It's an invalid_request,
  // not a tool-support refusal.
  const CACHE_CONTROL_ORDERING_ERROR =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"system.0.cache_control.ttl: ' +
    'a ttl=\'1h\' cache_control block must not come after a ttl=\'5m\' cache_control block. ' +
    'Note that blocks are processed in the following order: `tools`, `system`, `messages`."}}'

  it('does NOT classify cache_control TTL ordering errors as model_no_tool_support', () => {
    const parsed = parseError(new Error(CACHE_CONTROL_ORDERING_ERROR))
    expect(parsed.code).not.toBe('model_no_tool_support')
  })

  it('classifies cache_control TTL ordering errors as invalid_request', () => {
    const parsed = parseError(new Error(CACHE_CONTROL_ORDERING_ERROR))
    expect(parsed.code).toBe('invalid_request')
  })

  it('still classifies explicit tool-support refusals as model_no_tool_support', () => {
    const cases = [
      'No endpoints found that support tool use for this model',
      'The model gpt-3.5-turbo-instruct does not support tools',
      'tool_use is not supported by this model',
      'function calling not available on this endpoint',
    ]
    for (const message of cases) {
      const parsed = parseError(new Error(message))
      expect(parsed.code).toBe('model_no_tool_support')
    }
  })
})

describe('rate limit and truncation text', () => {
  it('does not promise a retry that already ran out', () => {
    const parsed = parseError(new Error('429 Individual quota reached. Resets in 40h1m10s'))
    expect(parsed.code).toBe('rate_limited')
    expect(parsed.message).toBe('Rate limit reached. Retries did not succeed.')
    expect(parsed.actions.some(a => a.action === 'retry')).toBe(true)
  })

  it('defines output_truncated as a retryable error with a Retry action', () => {
    const error = createAgentError('output_truncated')
    expect(error.title).toBe('Reply Cut Off')
    expect(error.canRetry).toBe(true)
    expect(error.actions.some(a => a.action === 'retry')).toBe(true)
  })
})

describe('parseRateLimitResetAt', () => {
  const NOW = 1_800_000_000_000

  it('reads the Antigravity quota text', () => {
    const text = '429 Individual quota reached for this model. Resets in 40h1m10s'
    expect(parseRateLimitResetAt(text, NOW)).toBe(NOW + (40 * 3600 + 1 * 60 + 10) * 1000)
  })

  it('reads "try again in" with seconds, minutes and fractions', () => {
    expect(parseRateLimitResetAt('Rate limit reached. Please try again in 20s.', NOW)).toBe(NOW + 20_000)
    expect(parseRateLimitResetAt('Please try again in 5 minutes', NOW)).toBe(NOW + 300_000)
    expect(parseRateLimitResetAt('Please try again in 6.4s', NOW)).toBe(NOW + 6_400)
    expect(parseRateLimitResetAt('try again in 350ms', NOW)).toBe(NOW + 350)
    expect(parseRateLimitResetAt('Try again in 2 hours 5 minutes.', NOW)).toBe(NOW + (2 * 3600 + 5 * 60) * 1000)
  })

  it('reads "retry after" in seconds, with a unit or as a bare Retry-After value', () => {
    expect(parseRateLimitResetAt('retry after 30 seconds', NOW)).toBe(NOW + 30_000)
    expect(parseRateLimitResetAt('429 Too Many Requests (Retry-After: 45)', NOW)).toBe(NOW + 45_000)
  })

  it('reads an ISO timestamp after "reset"', () => {
    expect(parseRateLimitResetAt('Quota exhausted, resets at 2026-11-01T08:30:00Z', NOW)).toBe(Date.parse('2026-11-01T08:30:00Z'))
    expect(parseRateLimitResetAt('quota will reset: 2026-11-01T08:30:00+08:00', NOW)).toBe(Date.parse('2026-11-01T08:30:00+08:00'))
  })

  it('returns undefined for texts without a reset time', () => {
    for (const text of ['', '429 Too many requests', 'Rate limit reached', 'resets in a while', 'try again in 5 fortnights', 'created 2026-11-01T08:30:00Z']) {
      expect(parseRateLimitResetAt(text, NOW)).toBeUndefined()
    }
  })
})
