import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const SERVICE_MODULE = pathToFileURL(join(import.meta.dir, 'index.ts')).href

interface FetchCase {
  status?: number
  body?: unknown
  throws?: boolean
}

/**
 * Run `refreshNow` for one connection in a subprocess with an isolated config
 * dir (the store is module-level, so the user's real config is never touched)
 * and a stubbed `fetch`. Returns the fetch calls and the connection afterwards.
 */
function refresh(connection: Record<string, unknown>, fetchCase: FetchCase) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-compat-models-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
    id: 'ws-config-1', name: 'My Workspace', slug: 'my-workspace', createdAt: 1, updatedAt: 1,
  }), 'utf-8')
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: 1 }],
    activeWorkspaceId: 'ws-1',
    activeSessionId: null,
    defaultLlmConnection: 'compat',
    llmConnections: [{
      slug: 'compat', name: 'Compat', providerType: 'pi_compat', authType: 'api_key_with_endpoint', createdAt: 1,
      defaultModel: 'm1', ...connection,
    }],
  }), 'utf-8')

  const script = `
    import { initModelRefreshService } from ${JSON.stringify(SERVICE_MODULE)}
    const fetchCase = JSON.parse(process.env.FETCH_CASE)
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} })
      if (fetchCase.throws) throw new Error('boom')
      return new Response(JSON.stringify(fetchCase.body ?? {}), { status: fetchCase.status ?? 200 })
    }
    await initModelRefreshService(async () => ({ apiKey: 'sk-test' })).refreshNow('compat')
    console.log('__CALLS__' + JSON.stringify(calls))
  `
  const run = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir, FETCH_CASE: JSON.stringify(fetchCase) },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (run.exitCode !== 0) throw new Error(`subprocess failed:\n${run.stderr.toString()}`)
  const out = run.stdout.toString()
  const calls = JSON.parse(out.slice(out.indexOf('__CALLS__') + '__CALLS__'.length).split('\n')[0]!) as Array<{ url: string; headers: Record<string, string> }>
  const saved = JSON.parse(readFileSync(configPath, 'utf-8')).llmConnections[0]
  return { calls, saved }
}

const LIST = {
  data: [
    { id: 'm1', context_window: 200000, max_output_tokens: 65536, reasoning: true, modalities: { input: ['text', 'image'] } },
    { id: 'm2', context_window: 100000, max_output_tokens: 8000 },
    { id: 'not-listed', context_window: 1000 },
  ],
}

describe('ModelRefreshService custom endpoint enrichment', () => {
  it('fills only missing fields, never replaces the model list', () => {
    const { calls, saved } = refresh(
      { baseUrl: 'http://gw.test:3425', customEndpoint: { api: 'openai-completions' }, models: ['m1', { id: 'm2', name: 'm2', shortName: 'm2', maxTokens: 1234 }] },
      { body: LIST },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://gw.test:3425/v1/models')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test')
    expect(saved.models).toEqual([
      { id: 'm1', name: 'm1', shortName: 'm1', contextWindow: 200000, maxTokens: 65536, supportsThinking: true, supportsImages: true },
      { id: 'm2', name: 'm2', shortName: 'm2', maxTokens: 1234, contextWindow: 100000 },
    ])
    expect(saved.defaultModel).toBe('m1')
  })

  it('does not add /v1 when the base URL already has a version segment', () => {
    const { calls } = refresh(
      { baseUrl: 'https://api.test/api/v1/', customEndpoint: { api: 'openai-completions' }, models: ['m1'] },
      { body: LIST },
    )
    expect(calls[0]!.url).toBe('https://api.test/api/v1/models')
  })

  it('uses /v1/models with the anthropic-version header for anthropic-messages', () => {
    const { calls } = refresh(
      { baseUrl: 'https://proxy.test', customEndpoint: { api: 'anthropic-messages' }, models: ['m1'] },
      { body: LIST },
    )
    expect(calls[0]!.url).toBe('https://proxy.test/v1/models')
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[0]!.headers['x-api-key']).toBe('sk-test')
  })

  it('leaves the connection alone on an HTTP error, a network error or an unknown list', () => {
    const base = { baseUrl: 'http://gw.test', customEndpoint: { api: 'openai-completions' }, models: ['m1'] }
    expect(refresh(base, { status: 500 }).saved.models).toEqual(['m1'])
    expect(refresh(base, { throws: true }).saved.models).toEqual(['m1'])
    expect(refresh(base, { body: { data: [{ id: 'm1', object: 'model' }] } }).saved.models).toEqual(['m1'])
  })

  it('does not call the endpoint without a custom endpoint, a base URL or listed models', () => {
    expect(refresh({ baseUrl: 'http://gw.test', models: ['m1'] }, { body: LIST }).calls).toHaveLength(0)
    expect(refresh({ customEndpoint: { api: 'openai-completions' }, models: ['m1'] }, { body: LIST }).calls).toHaveLength(0)
    expect(refresh({ baseUrl: 'http://gw.test', customEndpoint: { api: 'openai-completions' } }, { body: LIST }).calls).toHaveLength(0)
  })
})
