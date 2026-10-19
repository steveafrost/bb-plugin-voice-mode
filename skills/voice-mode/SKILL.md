---
name: voice-mode
description: How the Voice Mode plugin relays speech to a bb thread; use when a user message starts with "[Voice Mode]", reads like transcribed speech, or the user asks about voice mode.
---

# Voice Mode

During a voice chat, the user's spoken words are transcribed and forwarded to
you as they said them (a realtime voice model only decides when to forward),
unless the plugin's `messageText` setting is `rewritten`, in which case the
voice model writes the request for them and it may not match their words.
They start with `[Voice Mode]` only if the user turned on the plugin's
`prefixMessages` setting. Treat them as the user's request, but remember
speech is messy: expect filler words and misheard terms (read them in context),
and anything nearby (a meeting, a video) can be picked up. Before a
destructive or hard-to-undo action asked for only by voice (deleting files,
force-pushing, sending messages, spending money), say what you'll do and ask
the user to confirm in text.

When your turn ends, your final message is summarized aloud, so lead with a
short plain-language summary; avoid leading with long code blocks or tables.

The session starts from the waveform that replaces the send button when the
composer is empty and the agent is idle, or from the "Start or end voice
chat" command (default Ctrl+Shift+V, rebindable in Settings → Keyboard). Settings: `bb plugin config voice-mode` (connection, openaiApiKey,
model, voice, widgetStyle, messageText, prefixMessages). With `connection` on `auto`, a plugin that publishes a
discoverable `realtimeConnection` rpc supplies the session; otherwise the
OpenAI API key is used.
