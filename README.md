# bb-plugin-voice-mode

Talk to a bb thread hands-free. When a thread's composer is empty and its
agent is idle, the send button becomes a waveform: click it and you are in a
full-duplex voice chat.
The voice model hands real work to the thread's agent, tells you when the
agent is done, and stops talking the moment you talk over it.

- `server.ts` — the backend. A `bb.http` WebSocket route relays browser audio
  to an [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime)
  session and runs the voice model's tools (`send_to_agent`, `stop_agent`,
  `get_agent_status`) against the thread with `bb.sdk`. When the agent's turn
  settles, it hands the result back to the voice model to summarize aloud.
- `app.tsx`, `session.ts`, `audio.ts` — the frontend. A composer action swaps
  bb's send button for the waveform while the composer is empty and the agent
  is idle, and shows a
  pill (live waveform, status, mute, end) in place of bb's mic while a session
  runs. Mic capture is 24 kHz PCM with echo cancellation; playback can be cut
  instantly on barge-in.
- `skills/voice-mode/SKILL.md` — tells the thread's agent that messages
  starting with `[Voice Mode]` were spoken and relayed, and that its final
  message is read back.
- `test/` — backend tests against a fake host and a fake Realtime socket.

## Setup

Pick one in **Settings → Plugins → Voice Mode** (or `bb plugin config voice-mode`):

- **OpenAI API key** — set `openaiApiKey`. Choose `model` (`gpt-realtime-2`
  by default) and `voice`. The key is only ever sent to
  `wss://api.openai.com/v1/realtime`, and audio goes straight to OpenAI,
  around any company proxy. For another endpoint, use a connection plugin.
- **A connection plugin** — any installed plugin that publishes a discoverable
  `realtimeConnection` rpc returning
  `{ protocol: "openai-realtime", url, headers, model? }` (`url` must be
  `wss://`). That plugin picks the model; Voice Mode's `model` setting
  doesn't apply. This lets a company proxy own credentials and the model
  choice.

`connection` decides which one: `auto` (the default) uses a connection plugin
if one is installed and the API key only when none is. If the plugin is
installed but fails (say it has no token), the session fails with its error;
it doesn't quietly switch to your key. `plugin` and `openai-api-key` use only
that one.

Keys stay on the bb server host; the browser only talks to the plugin's own
WebSocket route.

## Use

- Empty composer with the agent idle → click the waveform ("Start new voice
  chat"). While the agent works, run **Toggle voice mode** from the command
  palette instead.
- Talk normally. Ask for anything that needs the codebase and the voice model
  sends it to the agent; ask "is it done?" any time; say "stop" to stop the
  agent. If the agent stops to ask you something (a question or a
  permission), the voice tells you to answer it in bb.
- Talk over the voice to interrupt it. The mute button keeps the session open
  without sending your mic; the × ends it.

## Privacy

While a session is on, the realtime provider you configured gets your
microphone audio, the thread title, the agent's latest message when you
start, and each agent reply that finishes during the session (first 2,500
characters of each). Nothing is sent until you start a session.

Agent replies can quote text from anywhere (issues, web pages, files), so
Voice Mode treats them as data: they never go in the voice model's
instructions, replies to them can't call tools, and the voice model can
forward at most one instruction to the agent per thing you say. Forwarded
messages start with `[Voice Mode]` so you and the agent can tell them apart.

## Limits

- bb has no plugin slot for its send button or mic. Voice Mode finds them by
  bb's DOM markers (`[data-promptbox-send-menu]`,
  `button[aria-label="Start voice input"]`), so a bb update can hide the
  waveform until the plugin catches up. bb's own send and dictation keep
  working either way.
- One session at a time per bb server; switching threads ends it.
- A session ends itself after 5 minutes with no speech and no reply playing
  (20 minutes while an agent turn is running), and after 30 minutes in any
  case, so a forgotten session doesn't keep streaming.

## Develop

```sh
npm install
npm run typecheck && npm test
bb plugin build && bb plugin install . --yes
```
