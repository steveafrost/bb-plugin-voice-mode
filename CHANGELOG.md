# Changelog

## 0.3.5

- Buffer assistant PCM playback through an `AudioWorklet` jitter buffer (with a `ScriptProcessorNode` fallback) so uneven packet delivery plays smoothly without losing barge-in or GPT-Live silent-frame filtering. Thanks to Ainur Minibaev (#12).
- Remove vendor-specific provider routing and settings labels: Voice Mode now prefers the active `realtimeConnection` plugin's `models.list` catalog (falling back to any other catalog plugin), retries once without a `model` override if a strict provider rejects it, and uses provider-neutral copy (#11).
- Update `@get-bb/plugin-sdk` to `0.6.157` (matching bb 0.50.1) and `hono` to `^4.13.16` while keeping `engines.bbPluginSdk` at `>=0.6.132` (#13).

## 0.3.4

- Pin the connection plugin install commands in settings and the README to exact tags (Realtime Gateway `v0.1.1`, `codex-realtime/v0.1.0`). bb treats a tag as pinned, so `bb plugin update` no longer follows new releases of those repositories.

## 0.3.3

- Say to update the connection plugin when it is installed but too old to list models. Shopify AI before 0.6.0 provides `realtimeConnection` without `models.list`, and the model pickers used to say to install it.

## 0.3.2

- Stop returning the previous task's output from `get_agent_status` while the agent is active or starting. The reply says work is still in progress.
- Say the user needs to answer or approve in bb when an interaction is pending, without the latest message.
- Tell the voice to acknowledge a sent task and wait for its result, and not to treat a pending result as missing project context.

## 0.3.1

- Copy a custom legacy realtime model setting to the picker on first start. Keep any saved picker selection.

## 0.3.0

- Add GPT-Live (`gpt-live-*`, protocol `openai-live`) support. Voice Mode connects to `wss://api.openai.com/v1/live/sessions` with an OpenAI API key, or to the URL that a `realtimeConnection` plugin returns.
- Delegate GPT-Live tool calls to an OpenAI Responses model. Pick it in the new **Delegation backend model** setting, or leave it on Auto to use the fastest live OpenAI model (`luna`, `nano`, `mini`, then `fast`). No model ID is hardcoded.
- Drop the silent PCM16 frames that GPT-Live streams while idle, so the pill returns to listening and idle timeouts count only real speech.
- Send agent turn results to GPT-Live as `session.commentary.append`, truncated to 900 characters. Agent output never enters the instructions and never triggers tools.
- Close GPT-Live sessions with `session.close` and fall back to closing the socket after 1.5 seconds.
- Add `api` to `VoiceModelOption`, `delegationModel` to `VoiceModelSelection`, and the `delegation` scope to `models.list`. Stored selections without `delegationModel` still load.
- Keep the `openai-realtime` protocol unchanged.

## 0.2.2

- Accept `groupLabel` and `latestModelsOnly` from `shopify-ai` `models.list` and propagate them through `voiceModeRpcContract["models.list"]` to settings.
- Group model pickers into `<optgroup>` sections by `groupLabel` (falling back to normalized vendor labels) in server order when multiple groups exist.
- Show a muted filter note instead of a destructive error when `latestModelsOnly` hides a retained model.
- Keep `settings.tsx` free of runtime imports from modules that import `@get-bb/plugin-sdk`.

## 0.2.1

- Restore the defaults `gpt-realtime-2` for API key connections, `gpt-4o-mini-transcribe` for input transcription, and the `marin` voice.
- Keep the selected model in each dropdown when the live catalog is empty, unlisted, or offline. The lists still come from live `realtime` and `audio_transcription` catalogs.
- A connection plugin keeps its own model until you pick one in the settings.

## 0.2.0

- Replace hardcoded realtime and transcription model lists with live dropdowns populated from the Shopify AI plugin or OpenAI.
- Scope the sidebar DOM observer once mounted and replace deprecated Zod URL and Web Audio APIs.
- Target `@get-bb/plugin-sdk@0.6.132`, `zod@4.6.7`. The source repository continues to use `tsc` for typechecking.
