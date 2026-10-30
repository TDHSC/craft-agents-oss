# Implementation plan: turn recovery and custom endpoint model limits

Design: [turn-recovery-and-endpoint-limits.md](./turn-recovery-and-endpoint-limits.md). Branch: `feat/turn-recovery-endpoint-limits`.

Ground rules:

- Each step below is one commit, in this order. Every step builds and passes tests on its own.
- Extend existing mechanisms before adding new ones. New modules are listed explicitly with the reason.
- Line numbers are as of `461f192` and only help you find the place. Search by the named function.
- Per-step checks: `bun run tsc --noEmit` in each package the step touches, plus the listed tests. Final check: `bun run validate:ci`, `bun run typecheck:electron` and `bun run lint:electron`.

---

## Step 1: keep endpoint overrides when a connection is edited

**Change.** In `packages/server-core/src/handlers/rpc/llm-connections.ts`, `SETUP_LLM_CONNECTION` (around :113-124):

- `customEndpoint`: merge `{ ...connection.customEndpoint, ...setup.customEndpoint }`, so `maxTokens` and `supportsImages` survive. Only the incoming `api` changes. This happens only when the connection stays `pi_compat`; the branch that switches to `anthropic` still clears it.
- `models`: when `setup.models` arrives, keep the existing entry object for every id that is still listed. New ids are added as given. Ids that were removed are dropped.
  - Put this in a small exported helper, `mergeModelEntries(existing, incoming)`, in `packages/shared/src/config/llm-connections.ts`, next to `setModelSupportsImages`. That file already handles per-model entries.

**Tests.**
- `packages/shared/src/config/__tests__/llm-connections.test.ts` covers `mergeModelEntries`: kept objects, added strings, removed ids, and order following the incoming list.
- A handler-level case covers the `customEndpoint` merge. Add it to the existing `llm-connections` handler test if there is one; otherwise test it through the helper.

**Deviations (as implemented).**
- `mergeModelEntries` replaces an incoming entry with the stored object only when the incoming entry is a plain string. An incoming object is an explicit definition (for example a Pi tier list) and wins as given. The design's intent is unchanged, since the compat form only sends plain ids.
- There is no handler-level test. The existing `connection-setup-updateOnly.test.ts` only simulates the guard logic, and the real handler needs the config store and credential manager, so a test could touch the user's config. The `customEndpoint` merge is a one-line spread; `mergeModelEntries` is unit-tested.

**Then, outside the repo:** set `customEndpoint.maxTokens: 65536` on the user's Magpie connection in `~/.craft-agent/config.json`. Save a `.bak` copy first. This stops the 8192 truncations right away.

**Commit:** `fix(llm-connections): keep endpoint overrides when a connection is edited`. The body explains that the form only sends `{api}` and plain ids.

## Step 2: per-model output cap and thinking support

**Shared shape.**
- `ModelDefinition` (`packages/shared/src/config/models.ts:120`) gains `maxTokens?: number`, with a doc comment: output cap, custom endpoints.
- Add one helper, `toCustomModelOverrides(models)`, in `packages/shared/src/config/llm-connections.ts`. It turns a connection's `models` into the wire shape `{ id, contextWindow?, supportsImages?, maxTokens?, supportsThinking? }`.

**Use the helper at every copy site.** Each site below copies per-model fields by hand today:
- `packages/server-core/src/sessions/runtime-config.ts:23` (`normalizeCustomModels`). Also add `maxTokens` and `supportsThinking` to `buildBackendRuntimeSignature`, so an edit refreshes live sessions.
- `packages/shared/src/agent/backend/internal/drivers/pi.ts:230`, the init payload.
- `packages/server-core/src/sessions/SessionManager.ts:3951`, the runtime update payload.

**Widen the type literals:**
- `driver-types.ts` (`BackendRuntimePayload`)
- `backend/types.ts` (`BackendRuntimeUpdate`)
- `pi-agent-server/src/index.ts`, the init and `update_runtime_config` message types (around :144 and :158)

**Pi subprocess** (`packages/pi-agent-server/src/custom-endpoint-models.ts`):
- `CustomEndpointModelOverrides` / `CustomEndpointModelConfig` gain `maxTokens?` and `supportsThinking?`.
- `normalizeCustomEndpointModelEntry` keeps them.
- In `buildCustomEndpointModelDef`:
  - `maxTokens: resolveMaxTokens(overrides?.maxTokens ?? defaults?.maxTokens)`
  - `reasoning: overrides?.supportsThinking === true`
- Update the doc comment to explain why the thinking check must be an explicit true.
- `index.ts:504` (`registerCustomEndpointModels`) copies the two new fields into `customModelOverrides`.

**Tests.**
- `packages/pi-agent-server/src/__tests__/custom-endpoint-models.test.ts`:
  - the cap order: per-model, then endpoint, then 8192;
  - `reasoning` is true only for an explicit `true`.
- `packages/server-core/src/sessions/runtime-config.test.ts`: the signature changes when `maxTokens` or `supportsThinking` changes.
- Shared tests for `toCustomModelOverrides`.

**Commit:** `feat(pi): per-model output cap and thinking support for custom endpoints`.

## Step 3: learn custom endpoint model limits from `/models`

**Parser.** New pure function `parseCustomEndpointModelMetadata(json)` in `packages/shared/src/config/model-fetcher.ts`, the existing home of model fetching.
- It returns `Map<id, { contextWindow?, maxTokens?, supportsThinking?, supportsImages? }>`.
- It accepts `{data: [...]}` or `{models: [...]}`, using the alias table in design D1.
- `maxTokens` is clamped to `contextWindow`.
- `max_model_len` is never read as `maxTokens`.

**Fill-only merge.** Pure function `fillMissingModelMetadata(models, metadata)` in `llm-connections.ts`. It sets only fields that are `undefined` on each entry. It turns a bare id into an object only when there is something to add, and returns `null` when nothing changed.

**Service.** In `packages/server-core/src/model-fetchers/index.ts` `_doRefresh`, replace the compat early return (:77) with a call to `this.enrichCompatModels(connection)`:
- It runs only for `customEndpoint` connections that have a `baseUrl`.
- It uses `this.getCredentials(slug)` for the API key and sends one `GET`.
  - For `openai-completions`: `{baseUrl}/models`, with `/v1` added when the base URL has no version segment, as `diagnostics.ts:162` does.
  - For `anthropic-messages`: `/v1/models` with the `anthropic-version` header.
  - Timeout 5 s. Failures are logged and ignored.
- On a change, it calls `updateLlmConnection(slug, { models })`.

The model list itself is never replaced, so `userDefined3Tier` lists stay exactly as they are. `startAll` and `refreshNow` keep skipping compat connections for timers: no periodic refresh, refresh at startup only. Remove the `isCompatProvider` guard in `startAll` only for the immediate fetch.

**Live sessions.** In `llm-connections.ts`, `refreshModelsInBackground` (:52) chains `sessionManager.refreshConnectionRuntime(slug)` after `refreshNow` resolves. This is the same hook the SAVE handler uses at :490, so an enrichment that finishes after setup still reaches open sessions.

**Tests.**
- Parser fixtures:
  - a Magpie-shaped list (from the live response);
  - an OpenRouter-shaped list;
  - an Anthropic-shaped list;
  - a plain OpenAI list with no metadata;
  - garbage input.
- Fill-only merge: never overwrites, and returns `null` when nothing changed.
- Service: with a mocked `fetch`, the compat path saves only the filled fields.

**Deviations (as implemented).**
- The plan said setup already runs the refresh service for every connection. It does not for a compat connection that already lists models (`SETUP_LLM_CONNECTION` awaits `refreshNow` only when the list is empty or auto-synced). The handler now also calls `refreshModelsInBackground` for those, detached, so editing a connection picks up `/models` without delaying the save.
- `diagnostics.ts` always appends `/v1/models`; it has no "version segment" check. The URL builder checks the base URL path for a `/vN` segment itself: `{base}/models` when present, else `{base}/v1/models`.
- `max_tokens` is read as the output cap only on an entry that also has `max_input_tokens` or `capabilities` (the Anthropic shape). This keeps `parseCustomEndpointModelMetadata(json)` a one-argument function.
- Only positive signals are reported. A model without `image` in its input modalities is left unset, not `false`, so a fill can never override an endpoint-wide `supportsImages: true`.
- `fillMissingModelMetadata` re-reads the connection after the request, in case it was edited while the request ran.
- The service test runs `refreshNow` in a subprocess with an isolated `CRAFT_CONFIG_DIR` and a stubbed `fetch`, as `storage-update-llm-connection.test.ts` does, because the config store is module-level.

**Commit:** `feat(model-fetchers): fill custom endpoint model limits from /models`. The body notes that there is no standard schema, and explains fill-only and the trade-off of having no periodic refresh.

## Step 4: show replies cut off by the output limit, fix rate-limit text

**Types and table.**
- `output_truncated` is added to `ErrorCode` (`packages/core/src/types/message.ts:461`).
- An entry is added to the error table in `packages/shared/src/agent/errors.ts`: title "Reply Cut Off", a message naming the limit, `canRetry: true` and a Retry action.

**Rate-limit text.**
- In `errors.ts:107`, the `rate_limited` message becomes "Rate limit reached. Retries did not succeed."
- `pi-agent.ts` `parsePiError` (:2856) uses the same table entry instead of its own string. That also removes the copy that has drifted.

**Pi adapter** (`packages/shared/src/agent/backend/pi/event-adapter.ts`, `message_end`): when a non-intermediate assistant message has `stopReason === 'length'`, yield `typed_error` `output_truncated`, after the existing `text_complete` when there is text. The output token count goes into the message. This replaces the `console.warn` branch (:596-607). Intermediate messages (`toolUse`) are untouched.

**Claude.** In `claude-sdk-error-mapper.ts:410`, `max_output_tokens` returns `code: 'output_truncated'` and keeps its existing details.

**Tests.**
- `packages/shared/src/agent/__tests__/pi-event-adapter.test.ts`: `length` with no text, `length` with text, and `toolUse` not affected.
- `claude-sdk-error-mapper.test.ts` and `errors.test.ts` updated.

**Commit:** `feat(agent): surface replies cut off by the output limit`.

## Step 5: ▶ Continue

### 5a. Shared rule

**New module:** `packages/shared/src/sessions/resumable-stop.ts`, exported in `packages/shared/package.json` as `./sessions/resumable-stop`. It is new because the `./sessions` barrel pulls in Node `fs`, and both the renderer and the server need this rule.

- `getResumableStop(messages): ResumableStop | null`, following the table in design D3. It skips `hidden` messages.
- `RESUMABLE_ERROR_CODES` is exported for the error card.
- Messages may be `Message` or stored messages: keep to `role`, `errorCode`, `statusType`, `hidden` and `errorResetAt`.

**Stop marker.**
- `statusType` in `core/types/message.ts` (:301, :380) gains `'interrupted'`.
- `SessionManager.cancelProcessing` (:7512) sets it on the "Response interrupted" row.

**Tests.** `packages/shared/src/sessions/__tests__/resumable-stop.test.ts`, one case per reason and per non-resumable code.

### 5b. Server

**Command.**
- `SessionCommand` (`packages/shared/src/protocol/dto.ts:518`) gains `| { type: 'continueTurn' }`.
- `handlers/rpc/sessions.ts` dispatches it next to `continueInNewSession` (:339).
- Add it to the `session-manager-interface.ts` method list if commands are mirrored there.

**`SessionManager.continueTurn(sessionId, trigger: 'user' | 'auto' = 'user')`:**
- Returns `false` when the session is processing, unknown, or `getResumableStop(managed.messages)` is `null`. It loads messages first if they are not loaded yet.
- Sets `managed.wasInterrupted = false`.
- Calls `sendMessage(sessionId, labelSystemNotice(CONTINUE_PROMPT), [], [], { hidden: true })`, where `CONTINUE_PROMPT = 'Continue where you left off.'`.
- Manual continue is a user action. `sendMessage` sets `turnFromUser = !hidden` (:6642). Add one internal option to `SendMessageOptions` (`continueTrigger?: 'user' | 'auto'`), and treat `continueTrigger === 'user'` as from the user. Do not add a parallel send path.

**Tests.** `packages/server-core/src/sessions/continue-turn.test.ts`, following `edit-resend.test.ts`:
- refused while processing or when nothing can be resumed;
- sends one hidden notice;
- clears `wasInterrupted`;
- user trigger counts as from the user.

### 5c. Renderer

**Button.**
- `SendButton.tsx` gains `canContinue: boolean` and `onContinue: () => void`.
- When not processing, `canContinue` is true and nothing is typed, it renders a `type="button"` with `Play`, `data-state="continue"` and `aria-label={t('chat.continueResponse')}`.
- Keep `SEND_BASE` and the same variant.

**Props.** Pass the two values through the same path as `onStop`: `ChatDisplay.tsx` (:1845) → `ChatInputZone` → `InputContainer.tsx` → `FreeFormInput.tsx` (:1927).
- `ChatDisplay` computes `canContinue = !session.isProcessing && getResumableStop(session.messages) !== null`.
- `onContinue` calls `window.electronAPI.sessionCommand(session.id, { type: 'continueTurn' })`. Use the existing command call; check the exact name in the transport.
- `FreeFormInput` passes `canContinue && !hasContent`.
- `submitMessage` and keyboard handling are not changed.

**Stop restore** (`ChatDisplay.tsx` `handleStop`, :1244):
- Restore the prompt only when no assistant or tool message comes after the last non-queued user message.
- Add a short comment linking the rule to ▶.

**Retry** (`ChatDisplay.tsx:1570`): when `RESUMABLE_ERROR_CODES` includes `turn.message.errorCode`, `onRetry` calls the same `onContinue`. Other errors keep the current resend.

**i18n.** Add `chat.continueResponse` ("Continue") to all 7 locales in `packages/shared/src/i18n/locales/`, keeping keys sorted.

**Tests.**
- Extend `error-message-actions.test.ts` if the Retry wiring is tested there.
- Add a pure `shouldRestorePromptOnStop(messages)` helper next to `handleStop`'s other helpers and unit-test it.

**Deviations (as implemented).**
- The two points the plan did not verify: the renderer sends a command with `window.electronAPI.sessionCommand(sessionId, command)`, and `session-manager-interface.ts` mirrors `SessionManager` methods, not `SessionCommand` variants. So `continueTurn(sessionId, trigger?)` is added to the interface as a method, and the `continueTurn` command handler returns nothing (the existing overloads of `sessionCommand` already allow `void`).
- `continueTurn` goes through the existing `wakeIdleSessionWithNotice` (hidden, labelled notice, fire-and-forget), which gains an optional `SendMessageOptions` argument, instead of calling `sendMessage` itself. The RPC therefore returns at once and not when the turn ends; `continueTrigger` travels in those options.
- Retry on the error card asks `getResumableStop([message])` instead of `RESUMABLE_ERROR_CODES.includes(code)`, so an `output_truncated` card also continues (it is not in that list: it has its own reason). It continues only when the session's last stop is resumable (`canContinue`); an older card keeps the resend. `RESUMABLE_ERROR_CODES` is still exported.
- `error-message-actions.test.ts` is not extended: the Retry wiring is inline in `ChatDisplay`, not in `error-message-actions.ts`. `shouldRestorePromptOnStop` lives in `lib/input-text.ts` next to the other restore helpers and is tested there.
- An assistant message with no text yet does not count as "produced something" in `shouldRestorePromptOnStop` (design: "no assistant text").

**Commit:** `feat(chat): continue an abnormally stopped turn from the composer`. The body names the hidden-notice choice and why the Pi `continue()` path was rejected (design §3.4).

## Step 6: auto-continue at the quota reset

**Settings toggle `autoContinueAfterLimitReset`.** Default `false`. Follow the `enable1MContext` path:
- `shared/config/storage.ts`: `StoredConfig` field, getter and setter.
- `protocol/channels.ts` and `protocol/routing.ts` (`REMOTE_ELIGIBLE_CHANNELS`).
- `server-core/handlers/rpc/settings.ts` (`HANDLED_CHANNELS` and `server.handle`).
- `apps/electron/src/shared/types.ts`, `transport/channel-map.ts` and `shared/__tests__/ipc-channels.test.ts`.
- `renderer/pages/settings/ai-settings-loader.ts` and its test.
- `AiSettingsPage.tsx`: state, load, handler and a `SettingsToggle` row under Performance.
- i18n `settings.ai.autoContinueAfterLimitReset` and `…Desc` in all 7 locales.

**Reset time.**
- `parseRateLimitResetAt(text, now): number | undefined` in `shared/agent/errors.ts`, covering the patterns in design D4.
- At the `typed_error` handler in `SessionManager.processEvent` (around :9439), for `rate_limited`, parse `errorOriginal ?? message` and:
  - store `errorResetAt` on the error message;
  - add "Resets at <local time>" to the stored content;
  - when the toggle is on and the session is attended, set `managed.autoContinueAt` and arm the timer.
- `errorResetAt` is added to the `Message` / stored message types and to the field lists in `messageToStored` and `loadMessagesFromDisk` (around :3193).

**Session field `autoContinueAt?: number`:**
- Added to `SessionConfig` / `SessionHeader` (`shared/sessions/types.ts`), to `SESSION_PERSISTENT_FIELDS` (:27) and to `ManagedSession`.
- Cleared in `sendMessage` for any non-hidden send, and when the continue fires.

**Timers.** In `SessionManager`, one `Map<sessionId, Timeout>`:
- `armAutoContinue(managed)`
- `clearAutoContinue(sessionId)`
- `fireAutoContinue(sessionId)`, which runs the guards from design D4 and then `continueTurn(sessionId, 'auto')`.
- `initialize()` re-arms from loaded headers after `loadSessionsFromDisk`.
- `dispose` clears the timers.
- The loop guard is an in-memory `Map<sessionId, number[]>` of fire times, at most 3 per 5 minutes.

**Persist `unattended`.** Add it to `SESSION_PERSISTENT_FIELDS`, so `craft run` sessions stay excluded by `isAttendedSession` after a restart.

**Tests.**
- `parseRateLimitResetAt` cases, including the real Antigravity text.
- `auto-continue.test.ts` (server-core sessions), with fake timers:
  - arms when the toggle is on;
  - does nothing when it is off;
  - a user send cancels it;
  - guards: archived, processing, unattended, loop limit;
  - re-armed at startup from a header.

**Deviations (as implemented).**
- `errorResetAt` needed only the two message types: `messageToStored` / `storedToMessage` copy fields with a rest-spread, so there is no field list to extend.
- The two RPC channels live in the `settings` group next to `autoCompactWindow`, not in `caching`, which is about prompt cache and context.
- A parsed reset time gets a 5 s margin (`AUTO_CONTINUE_MARGIN_MS`), since it is only as exact as the provider's text, and a reset further away than `setTimeout` can wait (2^31 - 1 ms) is not scheduled. Timers are also cleared on session delete and in `cleanup()`.
- The "Resets at <local time>" text is added to the error message sent to the renderer as well as to the stored content, so the live card and the reloaded one read the same.
- The startup re-arm loop is its own method (`rearmAutoContinues`) so a test can call it without a full `initialize()`.
- The tests record timers by replacing `setTimeout` instead of using fake timers: the Bun in this environment (1.3.1) has no `jest.advanceTimersByTime`, which is also why some existing Pi adapter tests fail here. The reset-time test uses the text form quoted in the design ("Individual quota reached … Resets in 40h1m10s"); session files under `~/.craft-agent` were not read to copy the exact text.

**Commit:** `feat(sessions): optionally continue a rate-limited turn when the quota resets`.

## Step 7: auto-continue after an app restart

**Toggle `autoContinueAfterRestart`.** Default `false`. Same plumbing as step 6; put both rows next to each other.

**Startup.** At the end of `SessionManager.initialize()`, when the toggle is on:
- Pick candidates from metadata: header `lastMessageRole !== 'assistant'`, and `lastMessageAt` within 24 h (`AUTO_CONTINUE_RESTART_WINDOW_MS`).
- For each candidate: load its messages, check `getResumableStop(...)?.reason === 'cut_off'`, then go through the same `fireAutoContinue` guards.
- Run this after the existing queued-message replay (:2709), so a session that is replaying its queue is not continued twice. `continueTurn` refuses a session that is already processing.

**Tests.** Extend `auto-continue.test.ts`:
- only `cut_off` is continued;
- outside the window is ignored;
- task, automation and hidden sessions are excluded;
- a session with a queued replay is not continued.

**Commit:** `feat(sessions): optionally continue turns cut off by an app restart`.

## Step 8: docs and final check

- `packages/shared/CLAUDE.md`: a short note each on per-model `maxTokens` / `supportsThinking` and fill-only `/models` enrichment, and on `getResumableStop` as the single rule.
- `bun run validate:ci`, `bun run typecheck:electron`, `bun run lint:electron`, plus the full `bun test` in `packages/shared` and `packages/server-core`.
- Manual check in the app: a Magpie connection, a forced small `maxTokens` to reproduce truncation, ▶ after an error, after Stop and after a restart, and both toggles.

**Commit:** `docs(shared): note per-model endpoint limits and resumable stops`.
