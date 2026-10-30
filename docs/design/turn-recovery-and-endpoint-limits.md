# Turn recovery and custom endpoint model limits

Status: accepted, 2026-10-30. Implementation plan: [turn-recovery-and-endpoint-limits-plan.md](./turn-recovery-and-endpoint-limits-plan.md).

## 1. Problem

Two Craft sessions (10-28 and 10-29) kept stopping and needed a manual "continue" (继续). The session files show three causes.

1. **Quota errors look like they will retry themselves, but they never do.** Eight lane sessions on `antigravity/gemini-4-argon` failed with `429 … Individual quota reached … Resets in 40h1m10s`. The error card said "Rate limit reached. Will auto-retry shortly." (`shared/agent/errors.ts:107`). By the time it showed, Pi had already used up its retries (4 agent-level and 2 provider-level, `pi-agent-server/src/session-settings.ts:48`). Nothing retried after that. The user typed "继续" between 30 minutes and 4.4 hours later.
2. **Empty replies cut off at 8192 tokens end the turn with no message.**
   - 17 of 323 calls to `google-vertex/gemini-4-argon` (through the Magpie gateway) ended with `stopReason: 'length'`, exactly 8192 output tokens and no content. None of the 1687 Antigravity calls did this.
   - Every custom endpoint model gets a fixed 8192 output cap (`DEFAULT_CUSTOM_ENDPOINT_MAX_TOKENS`) and `reasoning: false` (`pi-agent-server/src/custom-endpoint-models.ts`). Because of `reasoning: false`, the session thinking level is never sent as `reasoning_effort`. Gemini then thinks at its own default level and spends the whole budget thinking.
   - The Pi event adapter only calls `console.warn` here (`backend/pi/event-adapter.ts:601`), and packaged builds turn console logging off. The turn ends as if it had completed normally.
   - Magpie's `GET /v1/models` reports `max_output_tokens: 65536` for this model. Craft never reads that endpoint for `pi_compat` connections.
3. **Recovery tools are broken.**
   - Editing a connection in Settings deletes `customEndpoint.maxTokens` / `supportsImages` and every per-model override. The setup handler replaces `customEndpoint` and `models` with what the form sends: `{api}` and plain ids (`server-core/src/handlers/rpc/llm-connections.ts:113-124`).
   - The error card's Retry button sends the last user message again, which adds a duplicate bubble (`ChatDisplay.tsx:1570`). The button also disappears after a reload, because `errorActions` are never saved.

## 2. Goals and non-goals

Goals:

- **G1.** Show every abnormal stop in the conversation: a typed error, a reply cut off by the output limit, a user Stop, or a turn cut off by an app exit.
- **G2.** One click continues the turn. While the input is empty, Send turns into ▶.
- **G3.** Optional auto-continue at the quota reset time and after an app restart. Each has its own toggle, and both are off by default.
- **G4.** Use the real per-model limits and thinking support when an endpoint publishes them, and keep working when it does not.
- **G5.** Keep the diff small: extend existing mechanisms rather than adding parallel ones.

Non-goals (out of scope for this change):

- Continuing without any added message (see §3.4).
- The models.dev catalog fallback, periodic metadata refresh for compat connections, and a per-model limits editor in Settings.
- Saving error-card actions to disk. ▶ in the composer covers the reload case.

## 3. Research summary

### 3.1 `/v1/models` metadata has no standard

OpenAI's model object defines only `id`, `object`, `created` and `owned_by`. Everything beyond that is vendor-specific:

| Source | Context | Max output | Thinking / images |
|---|---|---|---|
| Magpie (documented, "when known") | `context_window` | `max_output_tokens` | `reasoning`, `reasoning_levels`, `modalities` |
| CLIProxyAPI, plain `/v1/models` | — (stripped to 4 fields in `OpenAIModels`) | — | — |
| CLIProxyAPI, `Anthropic-Version` header | `max_input_tokens` | `max_tokens` | fills in 200000 / 64000 when unknown |
| Anthropic | `max_input_tokens` | `max_tokens` | `capabilities.thinking`, `capabilities.image_input` |
| Gemini native | `inputTokenLimit` | `outputTokenLimit` | `thinking` |
| OpenRouter | `context_length` | `top_provider.max_completion_tokens` | `supported_parameters`, `architecture.input_modalities` |
| DeepSeek | `context_window` | `max_output_tokens` | `effort`, `input_modalities` |
| vLLM | `max_model_len` (total sequence, not output) | — | — |
| OpenAI, LiteLLM `/v1/models`, one-api | — | — | — |

Cline, Roo, Kilo, OpenCode and Cherry Studio mostly ask the user for limits or use a catalog. Conclusion: read these fields when they are present, and never depend on them.

### 3.2 How T3 Code continues

Source: pingdotgg/t3code.

- ▶ appears when the latest run is `interrupted`, or when it `failed` with error class `usage_limit` (`apps/web/src/components/ChatView.tsx:817`).
- Clicking it sends a real user message, "Continue where you left off.", with the composer's current model selection (`useComposerResume.ts`).
- The server continues interrupted runs after a restart, at most 3 in a row within 5 minutes (`RestartContinuation.ts`).
- When a usage limit has a known reset time, it can resume at that time or snooze the thread until then (`UsageLimitRecoveryWorker.ts`, setting `autoResumeLimitedThreads`).

### 3.3 Assistant prefill does not work across providers

Prefill means appending the partial reply as the model's own last message so the model continues it.

- **Rejected:**
  - Claude 4.6 and later (400 error); never allowed with thinking.
  - OpenAI Chat Completions has no such feature.
  - Gemini reportedly rejects requests that end with a model turn (secondary source).
- **Supported, each with its own parameter:**
  - DeepSeek: `prefix: true` on the beta base URL
  - Mistral: `prefix: true`
  - Kimi and Qwen: `partial: true`
  - vLLM: `continue_final_message`

Behind a gateway, Craft cannot tell which of these applies.

### 3.4 Why not call Pi's `agent.continue()` directly

`Agent.continue()` needs the transcript to end with a user or tool-result message. Called on its own, it has two problems:

- **It skips Craft's system prompt.** The override reaches the SDK only through `_runSystemPromptOptions.forceSystemPrompt`. That option is set in `AgentSession.prompt()` and cleared when the run finishes (`agent-session.js:1350, 1409, 1627`).
- **It runs outside the AgentSession run lifecycle.** The session reports itself idle while the agent runs, so no auto-retry, no compaction, and a concurrent `prompt()` throws.

Making it work would need private SDK APIs, which the repo forbids ("never through SDK internals"). The failed attempt itself does not pollute later requests: pi-ai's `transformMessages` already drops `error` and `aborted` assistant messages from every request.

**Decision:** continue by sending one hidden line, as T3 does. The user does not see it; the model sees one extra line per continue.

## 4. Design

### D1. Model limits for custom endpoints

**Per-model fields.** `ModelDefinition` gains `maxTokens?: number`. It already has `contextWindow`, `supportsThinking` and `supportsImages`. These fields live on the `models` entries of a `pi_compat` connection.

**Resolution, per model.** Pi uses the first value found:

| | 1st | 2nd | 3rd |
|---|---|---|---|
| Output cap | per-model `maxTokens` | `customEndpoint.maxTokens` | 8192 |
| Context window | per-model `contextWindow` | `assumedCustomEndpointContextWindow` | — |
| Thinking | `reasoning: true` only when per-model `supportsThinking === true` | | |

The thinking check must be an explicit `true`. `supportsThinking` counts as true when undefined in the rest of the app, but turning on `reasoning_effort` for every existing endpoint would break gateways that reject unknown parameters.

**Learning from the endpoint.**
- `ModelRefreshService` already runs after every connection setup and at startup, and currently skips compat connections. For compat connections it will now call `GET {baseUrl}/models` once. It never replaces the model list; it only *fills in fields that are missing* on existing entries.
- Fill-only means the user's own edits, and the composer's per-model image toggle, always win. To re-learn a value, delete it from the connection.
- After an update, live sessions are refreshed through the existing `SessionManager.refreshConnectionRuntime`.

**Field aliases (first match wins):**

| Field | Aliases |
|---|---|
| contextWindow | `context_window`, `context_length`, `max_input_tokens`, `inputTokenLimit`, `max_model_len` |
| maxTokens | `max_output_tokens`, `max_completion_tokens`, `top_provider.max_completion_tokens`, `outputTokenLimit`, `max_tokens` (Anthropic-format lists only) |
| supportsThinking | `reasoning === true`, a non-empty `reasoning_levels` / `supported_reasoning_levels`, `supported_parameters` containing `reasoning`, `capabilities.thinking.supported`, `thinking === true` |
| supportsImages | `image` in `modalities.input` / `input_modalities` / `architecture.input_modalities`, `capabilities.image_input.supported` |

`max_model_len` is the total sequence length, so it is never read as the output cap. A `max_output_tokens` larger than the context window is clamped to it, as Magpie does.

**Edit merge.** When a connection is saved:
- the setup handler keeps every existing `customEndpoint` field it does not set itself, and updates `api` only;
- for each id that was already in the list, it keeps the existing model object;
- new ids are added as plain strings.

### D2. Showing abnormal stops

- **New `ErrorCode` `output_truncated`.** The text is "Reply cut off at the output limit (N tokens)". It is defined in `ErrorCode` (`core/types/message.ts`) and the error table in `shared/agent/errors.ts`.
  - **Pi:** a final assistant `message_end` with `stopReason: 'length'` yields it, after any partial text. This replaces the `console.warn` branch.
  - **Claude:** the existing `max_output_tokens` mapping (`claude-sdk-error-mapper.ts:410`, currently `invalid_request` with the title "Output Too Large") uses the new code instead.
  - It is saved as an ordinary error message, so the existing error card shows it.
- **Rate-limit text.**
  - "Will auto-retry shortly" becomes an accurate "Retries did not succeed" in `errors.ts:107` and `pi-agent.ts:2856`.
  - When a reset time can be parsed (D4), the card text includes it.
- **User Stop.** The existing "Response interrupted" info row gains `statusType: 'interrupted'`. That field is already saved to disk; compaction notices use it today.

### D3. Resumable stops and ▶ Continue

**One rule, written once.** A pure, renderer-safe function `getResumableStop(messages)` lives in `packages/shared/src/sessions/resumable-stop.ts`, exported as `@craft-agent/shared/sessions/resumable-stop`. The `./sessions` barrel imports Node `fs`, so it cannot be used. The composer button, the Retry action and both auto-continue paths all use this one function. It looks at the last visible message (not hidden) and returns:

| Reason | When |
|---|---|
| `error` | a `role: 'error'` message whose code is `rate_limited`, `service_error`, `service_unavailable`, `provider_error`, `network_error` or `proxy_error` |
| `truncated` | an error message with code `output_truncated` |
| `stopped` | an info message with `statusType: 'interrupted'` |
| `cut_off` | the last message is from the user or a tool result, with nothing after it |
| `null` | anything else, including auth, billing, invalid-model and invalid-request errors, where continuing would fail the same way |

`error` results also carry the code and `errorResetAt`.

**Composer.**
- `SendButton` shows ▶ (lucide `Play`) when all three hold: the session is idle, the input has no content, and `getResumableStop` is not null.
- With text in the input it stays Send.
- Enter on an empty input still does nothing.

**Stop and the prompt restore.** Today an explicit Stop puts the in-flight prompt back in the input (`ChatDisplay.tsx` `handleStop`). The new rule:
- If the stopped turn produced nothing (no assistant text, no tool call after the last user message), restore the prompt as today; resending it is the natural action.
- Otherwise don't restore it, so ▶ shows. Clicking a sent message to edit it in place still covers "tweak and resend".

**Continue action.**
- A new `SessionCommand` variant `{ type: 'continueTurn' }` is dispatched in `handlers/rpc/sessions.ts`, the same way as `continueInNewSession`. This needs no new channel or routing entry.
- `SessionManager.continueTurn(sessionId, trigger: 'user' | 'auto')`:
  1. Checks that the session is idle and that `getResumableStop` is not null.
  2. Clears `wasInterrupted`. Otherwise the turn would carry the "previous response was interrupted, do not continue" reminder.
  3. Calls the existing `sendMessage(…, { hidden: true })` with `labelSystemNotice('Continue where you left off.')`.
- The turn uses the session's current model, so switching the model and then clicking ▶ works.
- A manual ▶ counts as a turn from the user, so TaskRunner treats it like a typed message. Auto-continue turns do not.
- **Retry on the error card.** For resumable errors it calls the same continue action instead of sending the last user message again.

### D4. Auto-continue (two toggles, default off)

**Settings.** Both live in Settings → AI → Performance, wired like `enable1MContext`:
- `autoContinueAfterLimitReset`: continue once the quota resets.
- `autoContinueAfterRestart`: continue turns an app exit cut off.

**At the quota reset.**
- `parseRateLimitResetAt(text, now)` in `shared/agent/errors.ts` recognises:
  - `Resets in 40h1m10s`
  - `try again in 20s` / `in 5 minutes`
  - `retry after N seconds`
  - an ISO timestamp after "reset"
- When the typed error is created, the result is saved:
  - on the error message as `errorResetAt`, which is added to the message type and to the stored and loaded message field lists;
  - on the session header as `autoContinueAt`, which is added to `SESSION_PERSISTENT_FIELDS`. Startup can then find pending sessions from headers alone, without loading messages.
- `SessionManager` keeps one `setTimeout` per pending session. At startup it re-arms them from the headers, and continues at once any that are already due.
- Sending any message clears `autoContinueAt`.

**After a restart.**
- At startup, candidates are sessions whose header `lastMessageRole` is not `assistant` and whose last activity is within 24 hours.
- Only those sessions load their messages. A session is continued when `getResumableStop` returns `cut_off`.

**Guards, checked when an auto-continue fires:**
- The toggle is still on.
- `isAttendedSession`: no task, automation, hidden, mini or unattended sessions. Task runs re-dispatch their steps in new child sessions after a restart, so continuing the old child would run the step twice.
- Not archived, and idle.
- `getResumableStop` still holds.
- No more than 3 auto-continues in 5 minutes per session (as in T3).

`unattended` is not saved today, so a `craft run` session counts as attended after a restart. It is added to `SESSION_PERSISTENT_FIELDS`.

## 5. Decisions taken with the user

| Question | Decision |
|---|---|
| Show ▶ after a user Stop | Yes |
| Enter on an empty input continues | No |
| Auto-continue at quota reset and after restart | Yes, each behind its own toggle |
| Stop puts the prompt back in the input | Only when the stopped turn produced nothing |
| Continue without adding anything vs one hidden line | One hidden line (§3.4) |
| Partial-text truncation | Same hidden line; no prefill, no merging |

## 6. Risks

- **An endpoint claims reasoning support but rejects `reasoning_effort`.** This only happens when the endpoint itself says reasoning is supported. Fix it by setting `supportsThinking: false` on that model.
- **Reset-time parsing is fragile.** Auto-continue is armed only when a time parses; otherwise ▶ is still there.
- **Auto-continue loops.** Covered by the guards in D4.
- **The empty `length` assistant message stays in history** and is sent to the model. The two manual "继续" messages on 10-29 show that this works; dropping it would need `appendContextEdit` and is left out.
