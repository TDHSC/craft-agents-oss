export type CustomEndpointInput = 'text' | 'image'

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses. */
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages'

/**
 * Output-token cap for custom endpoint models when the connection doesn't set
 * `customEndpoint.maxTokens`. We can't query an arbitrary endpoint for its real
 * limit, so the default stays conservative.
 */
export const DEFAULT_CUSTOM_ENDPOINT_MAX_TOKENS = 8_192

/**
 * Context window assumed for a custom endpoint model that declares none and
 * when no "Compact context at" is set (see `assumedCustomEndpointContextWindow`
 * in `session-settings.ts`).
 */
export const DEFAULT_CUSTOM_ENDPOINT_CONTEXT_WINDOW = 131_072

/** Connection-level custom endpoint config (`LlmConnection.customEndpoint`) as sent by the main process. */
export interface CustomEndpointConfig {
  api: CustomEndpointApi
  supportsImages?: boolean
  maxTokens?: number
}

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
  maxTokens?: number
  /** Window for models without a per-model `contextWindow`. */
  contextWindow?: number
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  supportsImages?: boolean
  /** Output cap for this model; wins over `customEndpoint.maxTokens`. */
  maxTokens?: number
  supportsThinking?: boolean
}

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  supportsImages?: boolean
  maxTokens?: number
  supportsThinking?: boolean
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.supportsThinking !== undefined ? { supportsThinking: model.supportsThinking } : {}),
  }
}

/**
 * Honor a configured output cap only when it's a positive integer. Config can
 * reach the subprocess unvalidated, and `0`/strings would otherwise become an
 * invalid `max_tokens` on anthropic-messages requests.
 */
function resolveMaxTokens(configured: number | undefined): number {
  return configured !== undefined && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_CUSTOM_ENDPOINT_MAX_TOKENS
}

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for context window and max tokens since we can't
 * query the endpoint for its actual capabilities. A per-model `contextWindow`
 * wins over the connection-level default the host derives from "Compact context
 * at". Image support must be explicitly enabled either at the connection level
 * or per-model.
 *
 * `reasoning` is on only for an explicit per-model `supportsThinking: true`
 * (learned from the endpoint's `/models`, or set by the user). The rest of the
 * app treats an undefined `supportsThinking` as true, but here that would send
 * `reasoning_effort` to every existing endpoint, and gateways that reject unknown
 * parameters would start failing. With `reasoning: false` the session thinking
 * level is never sent, so the model thinks at its own default.
 *
 * `maxTokens` is the model's output cap: per-model, then the connection-level
 * `customEndpoint.maxTokens`, then 8192. Pi also bounds compaction summaries by
 * it (`min(0.8 × reserveTokens, model.maxTokens)`), so that override is what lets
 * long-session summaries exceed the default. See craft-agents-oss#1100.
 *
 * For `openai-completions` endpoints we set `compat.supportsStore = false` so the
 * pi-ai driver omits the OpenAI-platform-specific `store` param entirely. Third-party
 * OpenAI-compatible gateways gain nothing from `store`, and strict ones reject unknown
 * params with a 400 — which made those connections unusable. See craft-agents-oss#1022.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
  api?: CustomEndpointApi,
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? false
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']

  return {
    id,
    name: id,
    reasoning: overrides?.supportsThinking === true,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? defaults?.contextWindow ?? DEFAULT_CUSTOM_ENDPOINT_CONTEXT_WINDOW,
    maxTokens: resolveMaxTokens(overrides?.maxTokens ?? defaults?.maxTokens),
    ...(api === 'openai-completions' ? { compat: { supportsStore: false } } : {}),
  }
}
