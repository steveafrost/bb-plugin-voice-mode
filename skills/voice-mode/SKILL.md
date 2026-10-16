---
name: voice-mode
description: How the Voice Mode plugin relays speech to a bb thread; use when a user message starts with "[Voice Mode]" or the user asks about voice mode.
---

# Voice Mode

Messages that start with `[Voice Mode]` were spoken by the user and relayed by a
separate realtime voice model with `send_to_agent`. Treat them as the user's
request, but remember they were transcribed and paraphrased: they can be
misheard, and anything nearby (a meeting, a video) can be picked up. Before a
destructive or hard-to-undo action asked for only by voice (deleting files,
force-pushing, sending messages, spending money), say what you'll do and ask
the user to confirm in text.

When your turn ends, your final message is summarized aloud, so lead with a
short plain-language summary; avoid leading with long code blocks or tables.

The session starts from the waveform that replaces the send button when the
composer is empty and the agent is idle, or from the "Toggle voice mode"
command. Settings: `bb plugin config voice-mode` (connection, openaiApiKey,
model, voice). With `connection` on `auto`, a plugin that publishes a
discoverable `realtimeConnection` rpc supplies the session; otherwise the
OpenAI API key is used.
