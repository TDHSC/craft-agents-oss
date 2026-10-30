/**
 * Model Fetcher — Centralized Model Discovery
 *
 * Type-safe plugin interface for fetching available models from providers.
 * Each provider (Anthropic, Pi) implements ModelFetcher.
 * The ModelFetcherMap enforces at compile time that every fetchable provider
 * has a registered fetcher — adding a new LlmProviderType without a fetcher
 * causes a type error.
 *
 * Compat providers (pi_compat) are excluded —
 * they point to arbitrary endpoints where users configure models manually.
 * The one thing read from them is the limits their `GET /models` publishes
 * (`parseCustomEndpointModelMetadata`), which only fills in missing fields.
 */

import type { ModelDefinition } from './models';
import type { LlmProviderType, LlmConnection } from './llm-connections';

// ============================================================
// Types
// ============================================================

/**
 * Providers that support automatic model fetching.
 * Compat providers are excluded — they point to arbitrary endpoints
 * (Ollama, OpenRouter, etc.) where users configure models manually.
 *
 * Adding a new LlmProviderType without updating this type
 * will cause a compile error in the fetcher registry.
 */
export type FetchableProvider = Exclude<LlmProviderType,
  | 'pi_compat'
>;

/**
 * Result of a model fetch operation.
 */
export interface ModelFetchResult {
  models: ModelDefinition[];
  /** Which model the provider considers the default (optional) */
  serverDefault?: string;
}

/**
 * Credentials needed to fetch models from a provider.
 * The ModelRefreshService resolves these from the credential manager.
 */
export interface ModelFetcherCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

/**
 * Plugin interface for provider-specific model discovery.
 *
 * Implementations live in apps/electron/src/main/model-fetchers/.
 * Each provider implements fetchModels() with its own SDK/API call.
 */
export interface ModelFetcher {
  /**
   * Fetch models from the provider API/SDK.
   * Throws on failure — the ModelRefreshService handles fallback.
   */
  fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult>;

  /**
   * Refresh interval in milliseconds.
   * 0 = fetch on auth/startup only, no periodic refresh.
   */
  readonly refreshIntervalMs: number;
}

/**
 * Type-safe fetcher map. Every FetchableProvider MUST have a fetcher.
 * Adding a new LlmProviderType without registering a fetcher → compile error.
 */
export type ModelFetcherMap = Record<FetchableProvider, ModelFetcher>;

// ============================================================
// Custom endpoint model metadata
// ============================================================

/** Limits and capabilities a custom endpoint publishes for one model in `GET /models`. */
export interface CustomEndpointModelMetadata {
  contextWindow?: number;
  maxTokens?: number;
  supportsThinking?: boolean;
  supportsImages?: boolean;
}

// There is no standard schema beyond `id`: every vendor names these fields
// differently (design: turn-recovery-and-endpoint-limits.md §3.1). First match wins.
// `max_model_len` (vLLM) is the total sequence length, so it is never an output cap.
const CONTEXT_WINDOW_PATHS = ['context_window', 'context_length', 'max_input_tokens', 'inputTokenLimit', 'max_model_len'];
const MAX_TOKENS_PATHS = ['max_output_tokens', 'max_completion_tokens', 'top_provider.max_completion_tokens', 'outputTokenLimit'];
const INPUT_MODALITY_PATHS = ['modalities.input', 'input_modalities', 'architecture.input_modalities'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (isRecord(cur) ? cur[key] : undefined), obj);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function firstPositiveInt(obj: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    const n = positiveInt(getPath(obj, path));
    if (n !== undefined) return n;
  }
  return undefined;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Read the limits and capabilities out of a custom endpoint's `GET /models`
 * response (`{ data: [...] }` or `{ models: [...] }`). Pure and forgiving:
 * unknown shapes and entries without a usable id or any known field are skipped.
 * Only positive signals are reported (a model that says nothing about images is
 * not reported as text-only), so a result can never override an endpoint default.
 */
export function parseCustomEndpointModelMetadata(json: unknown): Map<string, CustomEndpointModelMetadata> {
  const result = new Map<string, CustomEndpointModelMetadata>();
  if (!isRecord(json)) return result;
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];

  for (const entry of list) {
    if (!isRecord(entry)) continue;
    // Gemini's native list names models `models/<id>`.
    const id = typeof entry.id === 'string' ? entry.id
      : typeof entry.name === 'string' ? entry.name.replace(/^models\//, '')
      : undefined;
    if (!id) continue;

    const meta: CustomEndpointModelMetadata = {};
    const contextWindow = firstPositiveInt(entry, CONTEXT_WINDOW_PATHS);
    if (contextWindow !== undefined) meta.contextWindow = contextWindow;

    // Anthropic-format lists name the output cap `max_tokens`; elsewhere that name
    // is ambiguous, so it is read only next to Anthropic's own fields.
    let maxTokens = firstPositiveInt(entry, MAX_TOKENS_PATHS);
    if (maxTokens === undefined && ('max_input_tokens' in entry || 'capabilities' in entry)) {
      maxTokens = positiveInt(entry.max_tokens);
    }
    if (maxTokens !== undefined) {
      meta.maxTokens = contextWindow !== undefined ? Math.min(maxTokens, contextWindow) : maxTokens;
    }

    if (
      entry.reasoning === true
      || nonEmptyArray(entry.reasoning_levels)
      || nonEmptyArray(entry.supported_reasoning_levels)
      || (Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes('reasoning'))
      || getPath(entry, 'capabilities.thinking.supported') === true
      || entry.thinking === true
    ) {
      meta.supportsThinking = true;
    }

    if (
      INPUT_MODALITY_PATHS.some(path => {
        const modalities = getPath(entry, path);
        return Array.isArray(modalities) && modalities.includes('image');
      })
      || getPath(entry, 'capabilities.image_input.supported') === true
    ) {
      meta.supportsImages = true;
    }

    if (Object.keys(meta).length > 0 && !result.has(id)) result.set(id, meta);
  }
  return result;
}
