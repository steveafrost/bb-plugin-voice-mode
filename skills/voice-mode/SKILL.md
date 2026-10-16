---
name: voice-mode
description: How the Voice Mode plugin relays voice to a bb thread; use when a message in this thread came from Voice Mode or the user asks about voice mode.
---

# Voice Mode

The mic button in a thread header starts a full-duplex voice session (Shopify AI
Proxy realtime, Gemini Live by default). A separate voice model talks with the
user and forwards work to this thread with `send_to_agent`, which arrives as an
ordinary user message. When your turn ends, your final message is summarized
aloud, so end turns with a short plain-language summary first; avoid leading
with long code blocks or tables.

Settings: `bb plugin config voice-mode` (model, voice). Token comes from
`SHOPIFY_PROXY_KEY` or `devx llm-gateway print-token --key` on the bb server host.
