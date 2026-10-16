// Voice Mode: a full-duplex, interruptible voice conversation with a bb thread.
//
// The browser streams mic PCM over a WebSocket to this backend, which relays it
// to an OpenAI Realtime session. The voice model is a front-end for the
// thread's coding agent: it calls function tools that this backend runs against
// the thread through bb.sdk (send, stop, status). When the agent finishes a
// turn, the backend tells the voice model so it can report back aloud.
//
// Where the Realtime session comes from:
// - a plugin that publishes a `realtimeConnection` rpc (e.g. Shopify AI, which
//   routes through a company proxy), found with rpc discovery; or
// - an OpenAI API key set in this plugin's settings, against any OpenAI
//   Realtime compatible URL.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const PLUGIN_ID = "voice-mode";
const MAX_OUTPUT_CHARS = 2500;
const MAX_INSTRUCTION_CHARS = 8000;
const SAMPLE_RATE = 24000;
const CONNECTION_RPC = "realtimeConnection";

export const MODELS = ["gpt-realtime-2", "gpt-realtime", "gpt-realtime-mini"] as const;
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;
export const CONNECTIONS = ["auto", "plugin", "openai-api-key"] as const;

/** Messages the backend sends to the browser. */
export type ServerToBrowser =
  | { type: "READY"; inputHz: number; outputHz: number }
  | { type: "AUDIO"; base64Data: string }
  | { type: "INTERRUPTION" }
  | { type: "TRANSCRIPT"; role: "user" | "assistant"; text: string }
  | { type: "TOOL"; name: string; detail: string }
  | { type: "AGENT_STATUS"; status: string }
  | { type: "ERROR"; message: string }
  | { type: "ENDED" };

/** Messages the browser sends to the backend. */
export type BrowserToServer = { type: "AUDIO"; base64Data: string } | { type: "END" };

/** What a connection-providing plugin's `realtimeConnection` rpc returns. */
const RealtimeConnection = z.object({
  protocol: z.literal("openai-realtime"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  model: z.string().optional(),
});
type RealtimeConnection = z.infer<typeof RealtimeConnection>;

const TOOLS = [
  {
    type: "function",
    name: "send_to_agent",
    description:
      "Send an instruction or question to the coding agent working in this thread. Use this for any request that needs code, files, commands, research, or the agent's knowledge. If the agent is busy, the message steers its current work.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The complete instruction, written as the user would type it." },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "stop_agent",
    description: "Stop the coding agent's current work immediately. Use when the user says stop, cancel, or hold on.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_agent_status",
    description: "Get whether the coding agent is working or idle, and its latest message.",
    parameters: { type: "object", properties: {} },
  },
];

function instructions(title: string, lastOutput: string | null): string {
  return [
    "You are the voice of a coding agent workspace. The user talks to you hands-free while a separate coding agent does the work in a bb thread.",
    "You cannot read files, run commands, or write code yourself. For any real work or question about the project, call send_to_agent with a clear, complete instruction, then say a short confirmation.",
    "Only call send_to_agent for something the user actually asked for in this conversation.",
    "If the user says stop, cancel, or wait about the agent's work, call stop_agent.",
    "Messages that start with [bb update] come from the system, not the user. They report what the agent did. Summarize them for the user in one to three spoken sentences. Never read code, paths, or long lists aloud; describe them.",
    "Keep every reply short and conversational. The user can interrupt you at any time.",
    `Thread title (data): ${JSON.stringify(title)}`,
    lastOutput ? `The agent's latest message (data): ${JSON.stringify(truncate(lastOutput, MAX_OUTPUT_CHARS))}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    connection: {
      type: "select",
      label: "Connection",
      description:
        "auto: use a plugin that provides realtime connections (such as Shopify AI) if one is installed, else the OpenAI API key. plugin / openai-api-key: use only that.",
      options: [...CONNECTIONS],
      default: "auto",
    },
    openaiApiKey: {
      type: "string",
      label: "OpenAI API key",
      description: "Used when no plugin provides the connection. Stored on the bb server host only.",
      secret: true,
    },
    model: {
      type: "select",
      label: "Model (API key connections)",
      description: "A connection plugin picks its own model.",
      options: [...MODELS],
      default: MODELS[0],
    },
    voice: { type: "select", label: "Voice", options: [...VOICES], default: "marin" },
    realtimeUrl: {
      type: "string",
      label: "Realtime URL (API key connections)",
      description: "Any OpenAI Realtime compatible WebSocket endpoint.",
      default: "wss://api.openai.com/v1/realtime",
    },
  });

  async function pluginConnection(): Promise<RealtimeConnection | null> {
    const methods = await bb.sdk.plugins.experimental_discoverRpc();
    const provider = methods.find((m) => m.method === CONNECTION_RPC && m.pluginId !== PLUGIN_ID);
    if (!provider) return null;
    return bb.sdk.plugins.callRpc({
      pluginId: provider.pluginId,
      method: CONNECTION_RPC,
      input: {},
      outputSchema: RealtimeConnection,
    });
  }

  async function resolveConnection(): Promise<RealtimeConnection & { source: string }> {
    const { connection, openaiApiKey, model, realtimeUrl } = await settings.get();
    if (connection !== "openai-api-key") {
      const fromPlugin = await pluginConnection();
      if (fromPlugin) return { ...fromPlugin, source: "plugin" };
      if (connection === "plugin") {
        throw needsConfiguration("No realtime connection plugin is installed. Install one or use an OpenAI API key.");
      }
    }
    const key = openaiApiKey?.trim();
    if (!key) {
      throw needsConfiguration("Add an OpenAI API key in Voice Mode settings (or install a realtime connection plugin).");
    }
    const url = new URL(realtimeUrl || "wss://api.openai.com/v1/realtime");
    url.searchParams.set("model", model);
    return { protocol: "openai-realtime", url: url.toString(), headers: { authorization: `Bearer ${key}` }, model, source: "api-key" };
  }

  bb.http.experimental_websocket("/session", ({ url }) => {
    const threadId = url.searchParams.get("threadId") ?? "";
    let upstream: WebSocket | null = null;
    let browser: { send(data: string): void; close(code?: number, reason?: string): void } | null = null;
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    let ready = false;
    let lastStatus: string | null = null;
    let awaitingResult = false;
    // Response bookkeeping: bb updates wait for an idle model, tool outputs
    // need one response.create after the response that called them.
    let responseActive = false;
    let pendingTools: Promise<void>[] = [];
    const queuedUpdates: string[] = [];
    // Playback position of the reply being spoken, so a barge-in can tell the
    // model how much the user actually heard.
    let speaking: { itemId: string; startedAt: number; sentMs: number } | null = null;

    const toBrowser = (message: ServerToBrowser) => {
      if (!closed) browser?.send(JSON.stringify(message));
    };
    const toUpstream = (message: unknown) => {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(message));
    };
    const shutdown = () => {
      if (closed) return;
      toBrowser({ type: "ENDED" });
      closed = true;
      unsubscribe?.();
      upstream?.close(1000);
      browser?.close(1000);
    };
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`voice session ${threadId}: ${message}`);
      toBrowser({ type: "ERROR", message });
      shutdown();
    };

    const flushUpdates = () => {
      if (responseActive || pendingTools.length || !queuedUpdates.length) return;
      for (const text of queuedUpdates.splice(0)) {
        toUpstream({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      }
      toUpstream({ type: "response.create" });
    };

    async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
      switch (name) {
        case "send_to_agent": {
          const text = typeof args.text === "string" ? args.text.trim() : "";
          if (!text) return "Error: text is required.";
          await bb.sdk.threads.send({
            threadId,
            mode: "auto",
            input: [{ type: "text", text: truncate(text, MAX_INSTRUCTION_CHARS), mentions: [] }],
          });
          awaitingResult = true;
          toBrowser({ type: "TOOL", name, detail: text });
          return "Sent to the agent. It is working on it; you will get a [bb update] when it finishes.";
        }
        case "stop_agent": {
          await bb.sdk.threads.stop({ threadId });
          awaitingResult = false;
          toBrowser({ type: "TOOL", name, detail: "Stopped the agent" });
          return "The agent was stopped.";
        }
        case "get_agent_status": {
          const thread = await bb.sdk.threads.get({ threadId });
          const { output } = await bb.sdk.threads.output({ threadId });
          toBrowser({ type: "TOOL", name, detail: thread.status });
          return `Agent status: ${thread.status}. Latest message: ${output ? truncate(output, MAX_OUTPUT_CHARS) : "(none)"}`;
        }
        default:
          return `Error: unknown tool ${name}.`;
      }
    }

    function onFunctionCall(callId: string, name: string, rawArgs: string) {
      const task = (async () => {
        let output: string;
        try {
          const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
          output = await runTool(name, args);
        } catch (error) {
          output = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        toUpstream({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
      })();
      pendingTools.push(task);
    }

    async function onResponseDone() {
      responseActive = false;
      speaking = null;
      if (pendingTools.length) {
        const tools = pendingTools;
        await Promise.all(tools);
        pendingTools = pendingTools.filter((t) => !tools.includes(t));
        if (!responseActive) {
          responseActive = true;
          toUpstream({ type: "response.create" });
        }
        return;
      }
      flushUpdates();
    }

    function onSpeechStarted() {
      toBrowser({ type: "INTERRUPTION" });
      if (!speaking) return;
      // The server cancels the response itself (interrupt_response); trim the
      // reply to what was played so the model doesn't think it said it all.
      const heardMs = Math.max(0, Math.min(speaking.sentMs, Date.now() - speaking.startedAt));
      toUpstream({ type: "conversation.item.truncate", item_id: speaking.itemId, content_index: 0, audio_end_ms: Math.round(heardMs) });
      speaking = null;
    }

    async function onThreadChanged() {
      if (closed) return;
      const thread = await bb.sdk.threads.get({ threadId });
      const previous = lastStatus;
      lastStatus = thread.status;
      if (previous !== thread.status) toBrowser({ type: "AGENT_STATUS", status: thread.status });
      if (thread.status === "active" || thread.status === "starting") awaitingResult = true;
      const settled = thread.status === "idle" || thread.status === "error";
      if (!settled || !awaitingResult || previous === thread.status) return;
      awaitingResult = false;
      const { output } = await bb.sdk.threads.output({ threadId });
      queuedUpdates.push(
        thread.status === "error"
          ? "[bb update] The agent's turn failed with an error. Tell the user briefly."
          : `[bb update] The agent finished. Its final message (data): ${JSON.stringify(truncate(output ?? "(no message)", MAX_OUTPUT_CHARS))}`,
      );
      flushUpdates();
    }

    function onUpstreamEvent(event: Record<string, unknown>) {
      switch (event.type) {
        case "session.created":
          break;
        case "session.updated":
          if (!ready) {
            ready = true;
            toBrowser({ type: "READY", inputHz: SAMPLE_RATE, outputHz: SAMPLE_RATE });
            if (lastStatus) toBrowser({ type: "AGENT_STATUS", status: lastStatus });
          }
          break;
        case "response.created":
          responseActive = true;
          break;
        case "response.done":
          void onResponseDone();
          break;
        case "response.output_audio.delta": {
          const delta = String(event.delta ?? "");
          const itemId = String(event.item_id ?? "");
          if (!speaking || speaking.itemId !== itemId) speaking = { itemId, startedAt: Date.now(), sentMs: 0 };
          // base64 PCM16 mono: 4 chars -> 3 bytes, 2 bytes per sample.
          speaking.sentMs += ((delta.length * 3) / 4 / 2 / SAMPLE_RATE) * 1000;
          toBrowser({ type: "AUDIO", base64Data: delta });
          break;
        }
        case "input_audio_buffer.speech_started":
          onSpeechStarted();
          break;
        case "conversation.item.input_audio_transcription.completed":
          if (event.transcript) toBrowser({ type: "TRANSCRIPT", role: "user", text: String(event.transcript) });
          break;
        case "response.output_audio_transcript.done":
          if (event.transcript) toBrowser({ type: "TRANSCRIPT", role: "assistant", text: String(event.transcript) });
          break;
        case "response.function_call_arguments.done":
          onFunctionCall(String(event.call_id), String(event.name), String(event.arguments ?? ""));
          break;
        case "error": {
          const error = (event.error ?? {}) as { message?: string; code?: string };
          // Races like cancelling a finished response are harmless; only an
          // error before the session is configured is fatal.
          bb.log.warn(`voice session ${threadId}: realtime error ${error.code ?? ""} ${error.message ?? ""}`);
          if (!ready) fail(new Error(error.message ?? "Realtime session error"));
          break;
        }
      }
    }

    async function start() {
      const thread = await bb.sdk.threads.get({ threadId });
      lastStatus = thread.status;
      const { output } = await bb.sdk.threads.output({ threadId });
      const [connection, { voice }] = await Promise.all([resolveConnection(), settings.get()]);
      if (closed) return;
      bb.log.info(`voice session ${threadId}: ${connection.source} connection${connection.model ? ` (${connection.model})` : ""}`);

      // Node's WebSocket (undici) takes headers in its init object.
      upstream = new WebSocket(connection.url, { headers: connection.headers } as unknown as string[]);
      upstream.onopen = () =>
        toUpstream({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: instructions(thread.title ?? thread.titleFallback ?? "Untitled", output),
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: SAMPLE_RATE },
                transcription: { model: "gpt-4o-mini-transcribe" },
                turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
              },
              output: { format: { type: "audio/pcm", rate: SAMPLE_RATE }, voice },
            },
            tools: TOOLS,
            tool_choice: "auto",
          },
        });
      upstream.onerror = () => {
        if (!closed) fail(new Error("Voice connection failed"));
      };
      upstream.onclose = (event) => {
        if (!closed && event.code !== 1000) toBrowser({ type: "ERROR", message: `Voice connection closed (${event.code}${event.reason ? `: ${event.reason}` : ""})` });
        shutdown();
      };
      upstream.onmessage = async (event) => {
        const raw = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
        try {
          onUpstreamEvent(JSON.parse(raw) as Record<string, unknown>);
        } catch (error) {
          bb.log.warn(`voice session ${threadId}: bad event: ${String(error)}`);
        }
      };

      unsubscribe = bb.sdk.subscribe({
        event: "thread:changed",
        threadId,
        callback: () => void onThreadChanged().catch((error) => bb.log.warn(`thread watch: ${String(error)}`)),
      });
    }

    return {
      onOpen(socket) {
        browser = socket;
        if (!/^thr_[a-z0-9]+$/u.test(threadId)) return fail(new Error("Missing or invalid threadId"));
        start().catch(fail);
      },
      onMessage(_socket, data) {
        if (typeof data !== "string") return;
        let message: BrowserToServer;
        try {
          message = JSON.parse(data) as BrowserToServer;
        } catch {
          return;
        }
        if (message.type === "AUDIO" && typeof message.base64Data === "string") {
          if (ready) toUpstream({ type: "input_audio_buffer.append", audio: message.base64Data });
        } else if (message.type === "END") shutdown();
      },
      onClose() {
        browser = null;
        shutdown();
      },
      onError() {
        browser = null;
        shutdown();
      },
    };
  });
}
