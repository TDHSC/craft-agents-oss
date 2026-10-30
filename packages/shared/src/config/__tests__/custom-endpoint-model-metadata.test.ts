import { describe, expect, it } from 'bun:test'
import { parseCustomEndpointModelMetadata } from '../model-fetcher'
import { fillMissingModelMetadata } from '../llm-connections'
import type { ModelDefinition } from '../models'

// Entries from a live Magpie `GET /v1/models` (pricing and labels dropped).
const MAGPIE = {
  object: 'list',
  has_more: false,
  data: [
    {
      id: 'google-vertex/gemini-4-argon', object: 'model', type: 'model', owned_by: 'google-vertex',
      context_length: 1048576, context_window: 1048576, max_input_tokens: 1048576, max_output_tokens: 65536,
      modalities: { input: ['text', 'image'] },
      reasoning: true, reasoning_levels: ['low', 'medium', 'high'],
      supported_parameters: ['tools', 'tool_choice', 'reasoning'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
    },
    {
      id: 'zcode/GLM-5.3', object: 'model', type: 'model', owned_by: 'zcode',
      context_length: 1000000, context_window: 1000000, max_input_tokens: 1000000, max_output_tokens: 128000,
      modalities: { input: ['text'], output: ['text'] },
      reasoning: true, reasoning_levels: ['low', 'high', 'max'],
    },
    {
      id: 'deepseek/deepseek-flash', object: 'model', type: 'model', owned_by: 'deepseek',
      context_length: 1048576, context_window: 1048576, max_input_tokens: 1048576, max_output_tokens: 393216,
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: true, reasoning_levels: ['none', 'low', 'high', 'max'],
    },
  ],
}

describe('parseCustomEndpointModelMetadata', () => {
  it('reads a Magpie list', () => {
    const meta = parseCustomEndpointModelMetadata(MAGPIE)
    expect(meta.get('google-vertex/gemini-4-argon')).toEqual({
      contextWindow: 1048576, maxTokens: 65536, supportsThinking: true, supportsImages: true,
    })
    // No image in modalities.input: nothing is reported, not `false`.
    expect(meta.get('zcode/GLM-5.3')).toEqual({ contextWindow: 1000000, maxTokens: 128000, supportsThinking: true })
    expect(meta.get('deepseek/deepseek-flash')?.maxTokens).toBe(393216)
  })

  it('reads an OpenRouter list', () => {
    const meta = parseCustomEndpointModelMetadata({
      data: [{
        id: 'vendor/model',
        context_length: 200000,
        top_provider: { max_completion_tokens: 64000 },
        supported_parameters: ['tools', 'reasoning', 'include_reasoning'],
        architecture: { input_modalities: ['text', 'image'] },
      }],
    })
    expect(meta.get('vendor/model')).toEqual({
      contextWindow: 200000, maxTokens: 64000, supportsThinking: true, supportsImages: true,
    })
  })

  it('reads an Anthropic-format list, including max_tokens', () => {
    const meta = parseCustomEndpointModelMetadata({
      has_more: false,
      data: [{
        type: 'model', id: 'claude-x', display_name: 'Claude X',
        max_input_tokens: 200000, max_tokens: 64000,
        capabilities: { thinking: { supported: true }, image_input: { supported: true } },
      }],
    })
    expect(meta.get('claude-x')).toEqual({
      contextWindow: 200000, maxTokens: 64000, supportsThinking: true, supportsImages: true,
    })
  })

  it('reads a Gemini native list under `models`', () => {
    const meta = parseCustomEndpointModelMetadata({
      models: [{ name: 'models/gemini-x', inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true }],
    })
    expect(meta.get('gemini-x')).toEqual({ contextWindow: 1048576, maxTokens: 65536, supportsThinking: true })
  })

  it('never reads max_model_len as the output cap', () => {
    const meta = parseCustomEndpointModelMetadata({ data: [{ id: 'local', max_model_len: 32768 }] })
    expect(meta.get('local')).toEqual({ contextWindow: 32768 })
  })

  it('ignores a bare max_tokens outside the Anthropic shape', () => {
    expect(parseCustomEndpointModelMetadata({ data: [{ id: 'x', max_tokens: 4096 }] }).size).toBe(0)
  })

  it('clamps maxTokens to the context window', () => {
    const meta = parseCustomEndpointModelMetadata({ data: [{ id: 'x', context_window: 8000, max_output_tokens: 65536 }] })
    expect(meta.get('x')).toEqual({ contextWindow: 8000, maxTokens: 8000 })
  })

  it('skips non-positive and non-numeric limits', () => {
    const meta = parseCustomEndpointModelMetadata({
      data: [{ id: 'x', context_window: 0, max_output_tokens: '65536', max_completion_tokens: -1, context_length: 4096 }],
    })
    expect(meta.get('x')).toEqual({ contextWindow: 4096 })
  })

  it('reports nothing for a plain OpenAI list', () => {
    const meta = parseCustomEndpointModelMetadata({
      object: 'list',
      data: [{ id: 'gpt-x', object: 'model', created: 1, owned_by: 'openai' }],
    })
    expect(meta.size).toBe(0)
  })

  it('survives garbage', () => {
    for (const input of [null, undefined, 'text', 42, [], {}, { data: 'x' }, { data: [1, null, 'a', {}, { id: 7 }] }]) {
      expect(parseCustomEndpointModelMetadata(input).size).toBe(0)
    }
  })
})

describe('fillMissingModelMetadata', () => {
  const meta = new Map([
    ['a', { contextWindow: 1000, maxTokens: 500, supportsThinking: true, supportsImages: true }],
  ])
  const entry = (fields: Record<string, unknown>) => ({ id: 'a', name: 'a', shortName: 'a', ...fields }) as unknown as ModelDefinition

  it('promotes a bare id when there is something to add', () => {
    expect(fillMissingModelMetadata(['a', 'b'], meta)).toEqual([
      { id: 'a', name: 'a', shortName: 'a', contextWindow: 1000, maxTokens: 500, supportsThinking: true, supportsImages: true },
      'b',
    ] as never)
  })

  it('never overwrites a field that is already set, including explicit false', () => {
    const filled = fillMissingModelMetadata([entry({ supportsImages: false, maxTokens: 65536 })], meta)
    expect(filled).toEqual([entry({ supportsImages: false, maxTokens: 65536, contextWindow: 1000, supportsThinking: true })] as never)
  })

  it('returns null when nothing changed', () => {
    const full = entry({ contextWindow: 1, maxTokens: 2, supportsThinking: false, supportsImages: false })
    expect(fillMissingModelMetadata([full], meta)).toBeNull()
    expect(fillMissingModelMetadata(['unknown'], meta)).toBeNull()
    expect(fillMissingModelMetadata(['a'], new Map())).toBeNull()
  })

  it('matches an id stored with the pi/ prefix', () => {
    const filled = fillMissingModelMetadata(['pi/a'], meta)
    expect((filled![0] as ModelDefinition).maxTokens).toBe(500)
  })

  it('keeps the order and the other entries as they are', () => {
    const untouched = entry({ id: 'z' })
    const filled = fillMissingModelMetadata([untouched, 'a'], meta)
    expect(filled![0]).toBe(untouched)
  })

  it('does not mutate its input', () => {
    const models = [entry({})]
    const before = JSON.stringify(models)
    fillMissingModelMetadata(models, meta)
    expect(JSON.stringify(models)).toBe(before)
  })
})
