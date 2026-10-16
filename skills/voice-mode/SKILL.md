---
name: voice-mode
description: How the Voice Mode plugin relays voice to a bb thread; use when a message in this thread came from Voice Mode or the user asks about voice mode.
---

# Voice Mode

When the thread composer is empty, its send button becomes a waveform ("Start
new voice chat"); clicking it, or the "Toggle voice mode" command, starts a full-duplex voice session (Shopify AI
Proxy realtime, Gemini Live by default). While live, the mic becomes a pill with
a waveform, a mute toggle and an end button. A separate voice model talks with the
user and forwards work to this thread with `send_to_agent`, which arrives as an
ordinary user message. When your turn ends, your final message is summarized
aloud, so end turns with a short plain-language summary first; avoid leading
with long code blocks or tables.

Settings: `bb plugin config voice-mode` (model, voice). Token comes from
`SHOPIFY_PROXY_KEY` or `devx llm-gateway print-token --key` on the bb server host.
