# bb-plugin-voice-mode

Talk to a bb thread hands-free. When a thread's composer is empty, its send
button becomes a waveform: click it and you are in a full-duplex voice chat.
The voice model hands real work to the thread's agent, tells you when the
agent is done, and stops talking the moment you talk over it.

- `server.ts` — the backend. A `bb.http` WebSocket route relays browser audio
  to an [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime)
  session and runs the voice model's tools (`send_to_agent`, `stop_agent`,
  `get_agent_status`) against the thread with `bb.sdk`. When the agent's turn
  settles, it hands the result back to the voice model to summarize aloud.
- `app.tsx`, `session.ts`, `audio.ts` — the frontend. A composer action swaps
  bb's send button for the waveform while the composer is empty, and shows a
  pill (live waveform, status, mute, end) in place of bb's mic while a session
  runs. Mic capture is 24 kHz PCM with echo cancellation; playback can be cut
  instantly on barge-in.
- `skills/voice-mode/SKILL.md` — tells the thread's agent that messages may
  arrive by voice and that its final message is read back.
- `test/` — backend tests against a fake host and a fake Realtime socket.

## Setup

Pick one in **Settings → Plugins → Voice Mode** (or `bb plugin config voice-mode`):

- **OpenAI API key** — set `openaiApiKey`. Choose `model` (`gpt-realtime-2`
  by default) and `voice`. `realtimeUrl` points at any OpenAI Realtime
  compatible endpoint.
- **A connection plugin** — any installed plugin that publishes a discoverable
  `realtimeConnection` rpc returning
  `{ protocol: "openai-realtime", url, headers, model? }`. With `connection`
  on `auto` (the default) Voice Mode uses such a plugin when one is installed
  and falls back to the API key. This lets a company proxy own credentials and
  the model choice.

Keys stay on the bb server host; the browser only talks to the plugin's own
WebSocket route.

## Use

- Empty composer in a thread → click the waveform ("Start new voice chat"), or
  run **Toggle voice mode** from the command palette.
- Talk normally. Ask for anything that needs the codebase and the voice model
  sends it to the agent; ask "is it done?" any time; say "stop" to stop the
  agent.
- Talk over the voice to interrupt it. The mute button keeps the session open
  without sending your mic; the × ends it.

## Privacy

Your microphone audio, the thread title and the agent's latest message go to
the realtime provider you configured. Nothing is sent until you start a
session.

## Limits

- bb has no plugin slot for its send button or mic. Voice Mode finds them by
  bb's DOM markers (`[data-promptbox-send-menu]`,
  `button[aria-label="Start voice input"]`), so a bb update can hide the
  waveform until the plugin catches up. bb's own send and dictation keep
  working either way.
- One session at a time; switching threads ends it.
- A session ends itself after 5 minutes with no speech, no reply playing and
  no agent turn in flight, so a forgotten session doesn't keep streaming.

## Develop

```sh
npm install
npm run typecheck && npm test
bb plugin build && bb plugin install . --yes
```
