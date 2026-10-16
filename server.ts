// Voice Mode: a full-duplex, interruptible voice conversation with a bb thread.
//
// The browser streams mic PCM over a WebSocket to this backend, which relays it
// to a Shopify AI Proxy realtime session (Gemini Live by default). The voice
// model is a front-end for the thread's coding agent: it calls client tools
// that this backend runs against the thread through bb.sdk (send, stop,
// status). When the agent finishes a turn, the backend tells the voice model so
// it can report back aloud. Barge-in is native: the proxy emits INTERRUPTION
// and the browser drops queued playback.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const execFileAsync = promisify(execFile);

const PROXY_URL = "https://proxy.shopify.ai";
const TOKEN_CACHE_MS = 5 * 60 * 1000;
const MAX_OUTPUT_CHARS = 2500;
const MAX_INSTRUCTION_CHARS = 8000;
const PING_INTERVAL_MS = 5000;

export const MODELS = ["gemini-live-2.5-flash-native-audio"] as const;
export const VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"] as const;

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

const CLIENT_TOOLS = [
  {
    name: "send_to_agent",
    description:
      "Send an instruction or question to the coding agent working in this thread. Use this for any request that needs code, files, commands, research, or the agent's knowledge. If the agent is busy, the message steers its current work.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The complete instruction, written as the user would type it." },
      },
      required: ["text"],
    },
  },
  {
    name: "stop_agent",
    description: "Stop the coding agent's current work immediately. Use when the user says stop, cancel, or hold on.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_agent_status",
    description: "Get whether the coding agent is working or idle, and its latest message.",
    inputSchema: { type: "object", properties: {} },
  },
];

function systemPrompt(title: string, lastOutput: string | null): string {
  return [
    "You are the voice of a coding agent workspace. The user talks to you hands-free while a separate coding agent does the work in a bb thread.",
    "You cannot read files, run commands, or write code yourself. For any real work or question about the project, call send_to_agent with a clear, complete instruction, then say a short confirmation.",
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

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    model: { type: "select", label: "Voice model", options: [...MODELS], default: MODELS[0] },
    voice: { type: "select", label: "Voice", options: [...VOICES], default: "Puck" },
  });
  const { model, voice } = await settings.get();

  let tokenCache: { value: string; at: number } | null = null;
  async function proxyToken(): Promise<string> {
    const fromEnv = process.env.SHOPIFY_PROXY_KEY?.trim();
    if (fromEnv) return fromEnv;
    if (tokenCache && Date.now() - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.value;
    const { stdout } = await execFileAsync("devx", ["llm-gateway", "print-token", "--key"], { timeout: 15_000 });
    const value = stdout.trim();
    if (!value) throw new Error("`devx llm-gateway print-token --key` returned an empty token");
    tokenCache = { value, at: Date.now() };
    return value;
  }

  async function createSession(threadId: string, title: string, lastOutput: string | null) {
    const response = await fetch(`${PROXY_URL}/realtime/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await proxyToken()}` },
      body: JSON.stringify({
        assistant: { model, voice, systemPrompt: systemPrompt(title, lastOutput), clientTools: CLIENT_TOOLS },
        session: { owner: { id: "bb-voice-mode", type: "other" }, conversationId: `bb-voice-${threadId}-${Date.now()}` },
      }),
    });
    if (!response.ok) throw new Error(`Proxy session failed: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as { url: string; audioSampleRates?: { inputHz: number; outputHz: number } };
  }

  bb.http.experimental_websocket("/session", ({ url }) => {
    const threadId = url.searchParams.get("threadId") ?? "";
    let upstream: WebSocket | null = null;
    let browser: { send(data: string): void; close(code?: number, reason?: string): void } | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    // Only report turns the voice session started or saw start.
    let lastStatus: string | null = null;
    let inputHz = 16000;
    let awaitingResult = false;

    const toBrowser = (message: ServerToBrowser) => {
      if (!closed) browser?.send(JSON.stringify(message));
    };
    const toUpstream = (message: unknown) => {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(message));
    };
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      bb.log.warn(`voice session ${threadId}: ${message}`);
      toBrowser({ type: "ERROR", message });
      shutdown();
    };
    const shutdown = () => {
      if (closed) return;
      toBrowser({ type: "ENDED" });
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      unsubscribe?.();
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: "CLOSE_REQUEST" }));
        setTimeout(() => upstream?.close(), 1000);
      } else upstream?.close();
      browser?.close(1000);
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
      toUpstream({
        type: "TEXT",
        text:
          thread.status === "error"
            ? "[bb update] The agent's turn failed with an error. Tell the user briefly."
            : `[bb update] The agent finished. Its final message (data): ${JSON.stringify(truncate(output ?? "(no message)", MAX_OUTPUT_CHARS))}`,
      });
    }

    async function start() {
      const thread = await bb.sdk.threads.get({ threadId });
      lastStatus = thread.status;
      const { output } = await bb.sdk.threads.output({ threadId });
      const session = await createSession(threadId, thread.title ?? thread.titleFallback ?? "Untitled", output);
      if (closed) return;
      const rates = session.audioSampleRates ?? { inputHz: 16000, outputHz: 24000 };
      inputHz = rates.inputHz;

      upstream = new WebSocket(session.url);
      upstream.onopen = () => upstream?.send(JSON.stringify({ type: "PING", id: "ready" }));
      upstream.onerror = () => fail(new Error("Voice connection failed"));
      upstream.onclose = (event) => {
        if (!closed && event.code !== 1000) toBrowser({ type: "ERROR", message: `Voice connection closed (${event.code})` });
        shutdown();
      };
      upstream.onmessage = async (event) => {
        const raw = typeof event.data === "string" ? event.data : await (event.data as Blob).text();
        const message = JSON.parse(raw) as Record<string, unknown>;
        switch (message.type) {
          case "PONG":
            if (message.id === "ready") {
              toBrowser({ type: "READY", ...rates });
              toBrowser({ type: "AGENT_STATUS", status: thread.status });
              pingTimer = setInterval(() => toUpstream({ type: "PING", id: "keepalive" }), PING_INTERVAL_MS);
            }
            break;
          case "AUDIO_CHUNK":
            toBrowser({ type: "AUDIO", base64Data: String(message.base64Data ?? "") });
            break;
          case "INTERRUPTION":
            toBrowser({ type: "INTERRUPTION" });
            break;
          case "TRANSCRIPTION":
            toBrowser({
              type: "TRANSCRIPT",
              role: message.role === "user" ? "user" : "assistant",
              text: String(message.content ?? ""),
            });
            break;
          case "TOOL_CALL": {
            const id = String(message.id);
            const name = String(message.name);
            let text: string;
            let isError = false;
            try {
              text = await runTool(name, (message.arguments ?? {}) as Record<string, unknown>);
            } catch (error) {
              text = `Error: ${error instanceof Error ? error.message : String(error)}`;
              isError = true;
            }
            toUpstream({ type: "TOOL_CALL_RESULT", id, name, content: [{ type: "text", text }], isError });
            break;
          }
          case "SESSION_ERROR":
            fail(new Error(String(message.message ?? message.error ?? "Voice session error")));
            break;
          case "SESSION_END":
          case "CLOSE_ACK":
            shutdown();
            break;
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
          toUpstream({ type: "AUDIO_CHUNK", mimeType: `audio/pcm;rate=${inputHz}`, base64Data: message.base64Data });
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
