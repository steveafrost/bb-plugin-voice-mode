# bb-plugin-voice-mode

Talk to a bb thread hands-free. When a thread's composer is empty and its
agent is idle, the send button becomes a waveform: click it and you are in a
full-duplex voice chat.
The voice model hands real work to the thread's agent, tells you when the
agent is done, and stops talking the moment you talk over it.

[![Voice Mode demo: start a voice chat, the agent answers, the voice reads back a summary](media/demo.gif)](https://github.com/steveafrost/bb-plugin-voice-mode/releases/download/v0.1.0/voice-mode-demo-public.mp4)

[Watch the full 90-second demo with sound](https://github.com/steveafrost/bb-plugin-voice-mode/releases/download/v0.1.0/voice-mode-demo-public.mp4).

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
- `skills/voice-mode/SKILL.md` — tells the thread's agent how voice messages
  arrive (the user's own transcribed words, optionally marked `[Voice Mode]`)
  and that its final message is read back.
- `test/` — backend tests against a fake host and a fake Realtime socket.

## Setup

Choose a voice route in **Settings → Plugins → Voice Mode**.

| First model | Connection | Credentials and fallback |
| --- | --- | --- |
| Codex Live 1.1 | `codex-live-first` | Codex CLI signed in to ChatGPT on the BB server. Falls back directly to the configured subscription Realtime 2.1 connection. No project API key required. |
| GPT-Live-1 | `openai-live` or `live-first` | Project API key. Choose `openai-live` for Live only, or `live-first` to fall back to subscription Realtime 2.1. |
| Realtime 2.1 directly | `plugin` | Configure ChatGPT Realtime Connection (`codex-realtime`) for `gpt-realtime-2.1` and ensure discovery selects it. |

In settings, **Voice route and Realtime providers** shows the next call sequence, the current call in this client, and detected providers. Discovery checks plugin availability; a connected call confirms a live session. Live 1.1 has a separate voice selection. Live 1 and Realtime share the other voice setting, including after fallback. The connection menu displays model names and sign-in methods. The Direct Realtime API model field applies only to direct API calls. Each call starts with the selected route. The two Live modes with fallback go directly to Realtime 2.1 when their primary route is unavailable. The generic `auto` and direct Realtime API-key modes are described below.

- **Realtime with an OpenAI API key** — set `openaiApiKey`. Choose `model` (`gpt-realtime-2`
  by default) and `voice`. The key is only ever sent to
  `wss://api.openai.com/v1/realtime`, and audio goes straight to OpenAI,
  around any company proxy. For another endpoint, use a connection plugin.
- **A connection plugin** — any installed plugin that publishes a discoverable
  `realtimeConnection` rpc returning
  `{ protocol: "openai-realtime", url, headers, model? }` (`url` must be
  `wss://`). That plugin picks the model; Voice Mode's `model` setting
  doesn't apply. This lets a company proxy own credentials and the model
  choice. See [Connection plugins](#connection-plugins) for the two that are
  known to work.

`connection` decides which one:

- `auto` (the default) prefers an installed connection plugin. If none is
  available, or discovering or resolving its connection fails (for example,
  it has no token or returns an invalid connection), Voice Mode uses your
  configured OpenAI API key instead. Plugin resolution failures are logged
  on the server; switching to the key does not ask for confirmation. This
  sends audio and session context directly to OpenAI, bypassing any company
  proxy, and uses your OpenAI API account.
- `plugin` uses only a connection plugin. If it is missing or fails, the
  session fails; a configured OpenAI API key is never used. Choose this mode
  when sessions must stay on your company's connection.
- `openai-api-key` uses only the configured OpenAI API key and ignores
  connection plugins.

### Trying GPT-Live-1

Select `openai-live`, choose a voice (the default is Marin), and start a call
from a thread. A call uses the project's API billing. For a first test,
say “Проверь название текущего проекта”. Check that the thread receives the
spoken request once and that you hear its result. End the call with the hangup
button. To use your previous connection, select its previous Connection value.

Live streams 24 kHz PCM and uses client delegation. It forwards the
caller’s questions, follow-ups and requests verbatim to the current BB thread.
Follow-ups can steer work in progress. Greetings and microphone checks stay in voice. Use BB to stop work.
The Realtime model selector, rewritten text and Realtime VAD settings apply to
the Realtime connection modes. Session limits and the spoken-message prefix
also apply to Live. The API protocol tests run with `npm test` and a mock socket.

[OpenAI Live WebSocket](https://developers.openai.com/api/reference/resources/live/primary-websocket) · [Client delegation](https://developers.openai.com/api/docs/guides/live-delegation)

### GPT-Live with subscription fallback

For automatic selection choose **Connection → live-first**. Every call first
opens its own GPT-Live session when a project key is configured. Missing keys,
unavailable sessions, exhausted credits and interrupted Live connections switch
the same call to the installed ChatGPT Realtime Connection configured for
`gpt-realtime-2.1`. The call indicator reports the switch. The microphone
remains open during an in-call switch. Words spoken while reconnecting may
need repeating. Explicit hangup and content terminations end the call. A
failed subscription connection shows an error. This mode never substitutes a
metered Realtime project-key connection.


Eligible paid ChatGPT Pro and Business customers can claim promotional API credits in Billing. Select the API organization, confirm its grant and expiry in API Platform billing, and use a project key from that organization for GPT-Live-1. Promotional credits are spent first. API usage can continue against purchased credits after the grant runs out. Fallback reacts to a failed or unavailable session. The Codex Live 1.1 route uses the signed-in Codex allowance separately.

[OpenAI credit benefit and billing](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions) · [GPT-Live pricing](https://developers.openai.com/api/docs/models/gpt-live-1)

### Connection plugins

Voice Mode installs with none of these. Both below plug into the
`realtimeConnection` hook, so Voice Mode itself doesn't need to know about
them. Install one and leave `connection` on `auto`.

**Realtime Gateway** — runs sessions through a Vercel AI Gateway key, so voice
bills to one gateway account and the bb host never needs an OpenAI key:

```bash
bb plugin install 'git:github.com/steveafrost/bb-plugin-realtime-gateway@^0.1.1'
bb realtime-gateway test   # mint a secret and open one real session
```

Docs: https://github.com/steveafrost/bb-plugin-realtime-gateway

**ChatGPT Realtime Connection** (`codex-realtime`, by gpambrozio) — hands
Voice Mode the ChatGPT token `codex login` already stores on disk. This is the
subscription path:

```bash
bb plugin install 'git:github.com/gpambrozio/bb-plugins@>=0.1.0' --plugin codex-realtime --tag-prefix codex-realtime/
```

Docs: https://github.com/gpambrozio/bb-plugins/tree/main/codex-realtime

Only one connection plugin can serve a session: if two are installed, Voice
Mode asks the first one discovery returns and ignores the rest. Uninstall the
other, or set `connection` explicitly.

### Subscriptions and ChatGPT sign-in

For Codex Live 1.1, the local Codex CLI manages ChatGPT sign-in. For subscription Realtime 2.1, the ChatGPT Realtime Connection plugin supplies the connection.

It is a community plugin, not maintained here. Sending that token to the
Realtime API is undocumented by OpenAI, and OpenAI already refuses it for at
least one voice model (`gpt-live-1`), so it can stop working without notice.
Whether the ChatGPT or Codex terms permit another program to reuse the Codex
sign-in this way is not something this project has verified. Voice chats
started this way count against that ChatGPT plan.

To see which path a session used, check the source Voice Mode logs
(`bb plugin logs voice-mode`). Setting `connection` to `plugin` makes a
failing plugin's reason appear on screen instead of falling back to the key.

Without a usable plugin connection or API key, the session fails with setup
instructions. A plugin WebSocket handshake failure gets one connection
refresh attempt; the same selection rules apply if that refresh fails to
resolve a connection. The Live-first modes have the explicit fallback described above.

Keys stay on the bb server host; the browser only talks to the plugin's own
WebSocket route.

## Use

- Empty composer with the agent idle → click the waveform ("Start new voice
  chat"), or press **Ctrl+Shift+V** (Codex's shortcut) any time, including
  while the agent works. The same keys end the session. Rebind them in
  Settings → Keyboard ("Start or end voice chat"); the command is also in the
  palette.
- Talk normally. Ask for anything that needs the codebase and the voice model
  sends it to the agent; ask "is it done?" any time; say "stop" to stop the
  agent. If the agent stops to ask you something (a question or a
  permission), the voice tells you to answer it in bb.
- Talk over the voice to interrupt it. The mute button keeps the session open
  without sending your mic; the × ends it.
- Leave the thread (Settings, another thread) and the conversation keeps
  going in a pill at the bottom of the sidebar, above its footer (bottom-left
  of the window when the sidebar is collapsed): mute, end, or ↩ back to the
  thread from there. `widgetStyle` picks `detailed` (with the thread's name,
  the default) or `compact` (one line, no name).

## Privacy

While a session is on, the realtime provider you configured gets your
microphone audio, the thread title, the agent's latest message when you
start, and each agent reply that finishes during the session (first 2,500
characters of each). Nothing is sent until you start a session.

Agent replies can quote text from anywhere (issues, web pages, files), so
Voice Mode treats them as data: they never go in the voice model's
instructions, replies to them can't call tools, and the voice model can
forward at most one message to the agent per thing you say. By default that
message is your own words as transcribed, not the voice model's rewording, so
the agent sees what you actually said (filler and mishearings included). Set
`messageText` to `rewritten` to have the voice model write a clean instruction
instead; it reads better but can drift from what you said. Turn on
`prefixMessages` to start spoken messages with `[Voice Mode]` so the agent can
tell them from typed ones; it's off by default.

## Limits

- bb has no plugin slot for its send button or mic. Voice Mode finds them by
  bb's DOM markers (`[data-promptbox-send-menu]`,
  `button[aria-label="Start voice input"]`, `[data-promptbox-submit-group]`).
  If a bb update changes them, the waveform and pill fall back to the
  composer's plugin action slot beside bb's own buttons: less Codex-like, but
  still there. bb's own send and dictation keep working either way.
- One session at a time per bb server; starting one in another thread ends
  the first.
- A session ends itself after 5 minutes with no speech and no reply playing
  (20 minutes while an agent turn is running), and after 30 minutes in any
  case, so a forgotten session doesn't keep streaming.

## Develop

```sh
npm install
npm run typecheck && npm test
bb plugin build && bb plugin install . --yes
```

### Codex Live 1.1 with ChatGPT sign-in

On the BB server, install a Codex CLI with V3 realtime app-server support and sign in using the account that runs BB. Confirm the login with `codex login status`. From the matching plugin sources, run `python3 codex_voice.py --install` as that same user. This creates a local Python environment and installs the WebRTC bridge. Repeat this step after bridge updates.

Select **codex-live-first** in Voice Mode and start a call. The **Live 1.1** badge identifies the route requesting `gpt-live-1.1-codex` with the selected Codex Live voice. The browser sends audio to BB, and the local bridge connects to the model via WebRTC. Spoken tasks go to the current BB thread. This route uses the server's Codex login. For fallback, configure the ChatGPT Realtime Connection plugin for `gpt-realtime-2.1`. The existing project-key routes remain available.
