import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";

const THREAD = "thr_test123";

/** Stand-in for the upstream OpenAI Realtime socket the backend opens. */
class FakeUpstream {
  static last: FakeUpstream | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly init: { headers?: Record<string, string> },
  ) {
    FakeUpstream.last = this;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

vi.mock("../codex-voice-socket", () => ({
  CodexVoiceSocket: class { constructor() { return new FakeUpstream("codex-app-server", {}); } },
}));

beforeEach(() => {
  FakeUpstream.last = null;
  vi.stubGlobal("WebSocket", Object.assign(FakeUpstream, { OPEN: 1 }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The user says something: speech starts, the audio is committed, and (unless `transcript` is null) transcribed. */
function say(upstream: FakeUpstream, itemId: string, transcript: string | null = "go") {
  upstream.emit({ type: "input_audio_buffer.speech_started" });
  upstream.emit({ type: "input_audio_buffer.committed", item_id: itemId });
  if (transcript !== null) {
    upstream.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript });
  }
}

async function startSession(options: {
  settings?: Record<string, string | boolean>;
  connectionPlugin?: boolean;
  connectionUrl?: string;
  subscription?: boolean;
  connectionError?: Error;
  refreshError?: Error;
  interactions?: unknown[];
  thread?: Record<string, unknown>;
}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "voice-mode",
    settings: options.settings ?? {},
    sdk: {
      threads: {
        get: async () => ({ status: "idle", title: "Fix the build", ...options.thread }),
        output: async () => ({ output: "Build is green." }),
        send: async () => ({}),
        events: { list: async () => [] },
        stop: async () => ({}),
        interactions: { list: async () => options.interactions ?? [] },
      },
      subscribe: () => () => {},
      plugins: {
        experimental_discoverRpc: async () =>
          options.subscription ? [{ pluginId: "codex-realtime", method: "realtimeConnection" }] : options.connectionPlugin ? [{ pluginId: "shopify-ai", method: "realtimeConnection" }] : [],
        callRpc: async ({ input }: { input: { refresh?: boolean } }) => {
          if (options.connectionError) throw options.connectionError;
          if (input.refresh && options.refreshError) throw options.refreshError;
          return {
            protocol: "openai-realtime",
            url: options.connectionUrl ?? (options.subscription ? "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1" : "wss://proxy.example.com/v1/realtime?model=gpt-realtime-mini"),
            headers: { authorization: "Bearer proxy-token" },
            model: options.subscription ? "gpt-realtime-2.1" : "gpt-realtime-mini",
          };
        },
      },
    } as never,
  });
  plugin(bb);
  const browser = await harness.experimental_openWebSocket(`/session?threadId=${THREAD}`);
  await flush();
  const toBrowser = () => browser.sent.map((m) => JSON.parse(String(m)) as Record<string, unknown>);
  return { harness, browser, toBrowser, bb };
}

describe("connection", () => {
  it("uses the OpenAI API key and picked model when no plugin provides a connection", async () => {
    await startSession({ settings: { openaiApiKey: "sk-test", model: "gpt-realtime" } });
    const upstream = FakeUpstream.last!;
    expect(upstream.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime");
    expect(upstream.init.headers).toEqual({ authorization: "Bearer sk-test" });
  });

  it("prefers a plugin's realtimeConnection in auto mode", async () => {
    const { harness } = await startSession({ settings: { openaiApiKey: "sk-test" }, connectionPlugin: true });
    expect(FakeUpstream.last!.url).toBe("wss://proxy.example.com/v1/realtime?model=gpt-realtime-mini");
    expect(FakeUpstream.last!.init.headers).toEqual({ authorization: "Bearer proxy-token" });
    expect(harness.sdk.callsTo("plugins.callRpc")[0]?.[0]).toMatchObject({ pluginId: "shopify-ai", method: "realtimeConnection" });
  });

  it("falls back to the configured API key when plugin resolution fails in auto mode", async () => {
    const { harness, toBrowser } = await startSession({
      settings: { connection: "auto", openaiApiKey: "sk-test", model: "gpt-realtime" },
      connectionPlugin: true,
      connectionError: new Error("Missing proxy token"),
    });
    expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(1);
    expect(FakeUpstream.last!.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime");
    expect(FakeUpstream.last!.init.headers).toEqual({ authorization: "Bearer sk-test" });
    expect(toBrowser().filter((event) => event.type === "ERROR")).toEqual([]);
  });

  it("fails with setup instructions when plugin resolution fails without an API key", async () => {
    const { toBrowser } = await startSession({
      connectionPlugin: true,
      connectionError: new Error("Missing proxy token"),
    });
    expect(FakeUpstream.last).toBeNull();
    expect(toBrowser()[0]).toMatchObject({ type: "ERROR", message: expect.stringMatching(/OpenAI API key/) });
  });

  it.each([false, true])("never falls back to a configured API key in plugin mode (installed: %s)", async (installed) => {
    const { toBrowser } = await startSession({
      settings: { connection: "plugin", openaiApiKey: "sk-test" },
      connectionPlugin: installed,
      connectionError: new Error("Missing proxy token"),
    });
    expect(FakeUpstream.last).toBeNull();
    expect(toBrowser()[0]).toMatchObject({
      type: "ERROR",
      message: expect.stringMatching(installed ? /Missing proxy token/ : /No realtime connection plugin/),
    });
  });

  it("falls back to OpenAI instead of forwarding the key to an invalid plugin endpoint", async () => {
    await startSession({
      settings: { openaiApiKey: "sk-test" },
      connectionPlugin: true,
      connectionUrl: "ws://proxy.example.com/v1/realtime",
    });
    expect(FakeUpstream.last!.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2");
    expect(FakeUpstream.last!.init.headers).toEqual({ authorization: "Bearer sk-test" });
  });

  it("ignores connection plugins when set to the API key", async () => {
    await startSession({ settings: { openaiApiKey: "sk-test", connection: "openai-api-key" }, connectionPlugin: true });
    expect(FakeUpstream.last!.url).toContain("api.openai.com");
  });

  it("only sends the API key to OpenAI, whatever an old realtimeUrl setting says", async () => {
    await startSession({ settings: { openaiApiKey: "sk-test", realtimeUrl: "wss://attacker.example/v1/realtime" } });
    expect(FakeUpstream.last!.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2");
  });

  it("refuses a connection plugin's non-wss url", async () => {
    const { toBrowser } = await startSession({ connectionPlugin: true, connectionUrl: "ws://proxy.example.com/v1/realtime" });
    expect(FakeUpstream.last).toBeNull();
    expect(toBrowser()[0]).toMatchObject({ type: "ERROR" });
  });

  it("explains the setup when there is neither a key nor a connection plugin", async () => {
    const { toBrowser } = await startSession({});
    expect(FakeUpstream.last).toBeNull();
    expect(toBrowser()[0]).toMatchObject({ type: "ERROR", message: expect.stringMatching(/OpenAI API key/) });
  });
});

describe("session", () => {
  async function liveSession(settings: Record<string, string | boolean> = {}) {
    const session = await startSession({ settings: { openaiApiKey: "sk-test", voice: "cedar", ...settings } });
    const upstream = FakeUpstream.last!;
    upstream.open();
    upstream.emit({ type: "session.updated" });
    return { ...session, upstream };
  }

  it("configures audio, voice and the agent tools, then reports READY", async () => {
    const { upstream, toBrowser } = await liveSession();
    const [update] = upstream.ofType("session.update") as { session: Record<string, any> }[];
    expect(update!.session.audio.output.voice).toBe("cedar");
    expect(update!.session.audio.input.turn_detection).toMatchObject({ interrupt_response: true });
    expect(update!.session.tools.map((t: { name: string }) => t.name)).toEqual(["send_to_agent", "stop_agent", "get_agent_status"]);
    // Thread content is untrusted data: never in the system instructions.
    expect(update!.session.instructions).not.toContain("Fix the build");
    expect(update!.session.instructions).not.toContain("Build is green");
    expect(upstream.ofType("conversation.item.create")[0]).toMatchObject({
      item: { role: "user", content: [{ text: expect.stringMatching(/^\[bb update\].*Fix the build.*Build is green/) }] },
    });
    expect(upstream.ofType("response.create")).toHaveLength(0);
    expect(toBrowser()).toContainEqual({ type: "READY", inputHz: 24000, outputHz: 24000 });
  });

  it("relays mic audio upstream, dropping oversized frames", async () => {
    const { browser, upstream } = await liveSession();
    await browser.receive(JSON.stringify({ type: "AUDIO", base64Data: "AAAA" }));
    await browser.receive(JSON.stringify({ type: "AUDIO", base64Data: "A".repeat(300_000) }));
    expect(upstream.ofType("input_audio_buffer.append")).toEqual([{ type: "input_audio_buffer.append", audio: "AAAA" }]);
  });

  it("forwards what the user said, verbatim, and asks for a reply after the response ends", async () => {
    const { harness, upstream } = await liveSession();
    say(upstream, "u1", "um, can you run the tests");
    upstream.emit({ type: "response.created" });
    upstream.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "send_to_agent",
      // An old-style rewrite from the model is ignored.
      arguments: JSON.stringify({ text: "Run the test suite" }),
    });
    upstream.emit({ type: "response.done" });
    await flush();
    await flush();
    expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
      threadId: THREAD,
      input: [{ type: "text", text: "um, can you run the tests" }],
    });
    expect(upstream.ofType("conversation.item.create")[1]).toMatchObject({
      item: { type: "function_call_output", call_id: "call_1" },
    });
    // The follow-up only reports back; it can't chain more tool calls.
    expect(upstream.ofType("response.create")).toEqual([{ type: "response.create", response: { tool_choice: "none" } }]);
  });

  it("marks spoken messages with [Voice Mode] only when the setting is on", async () => {
    const { harness, upstream } = await liveSession({ prefixMessages: true });
    say(upstream, "u1", "Run the tests");
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "c", name: "send_to_agent", arguments: "{}" });
    await flush();
    await flush();
    expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
      input: [{ type: "text", text: "[Voice Mode] Run the tests" }],
    });
  });

  it("sends the voice model's own instruction when messageText is rewritten", async () => {
    const { harness, upstream } = await liveSession({ messageText: "rewritten" });
    const [update] = upstream.ofType("session.update") as { session: Record<string, any> }[];
    const send = update!.session.tools.find((t: { name: string }) => t.name === "send_to_agent");
    expect(send.parameters.required).toEqual(["text"]);
    say(upstream, "u1", "um, can you like run the tests");
    const call = (id: string) =>
      upstream.emit({ type: "response.function_call_arguments.done", call_id: id, name: "send_to_agent", arguments: '{"text":"Run the tests."}' });
    call("first");
    call("second");
    await flush();
    await flush();
    expect(harness.sdk.callsTo("threads.send").map((c) => (c[0] as { input: { text: string }[] }).input[0]!.text)).toEqual(["Run the tests."]);
  });

  it("waits for a transcript that lands after the tool call", async () => {
    const { harness, upstream } = await liveSession();
    say(upstream, "u1", null);
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "c", name: "send_to_agent", arguments: "{}" });
    await flush();
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
    upstream.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "fix the lint" });
    await flush();
    await flush();
    expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({ input: [{ text: "fix the lint" }] });
  });

  it("joins a clarifying answer with the original ask, and never forwards words twice", async () => {
    const { harness, upstream } = await liveSession();
    say(upstream, "u1", "run the tests");
    say(upstream, "u2", "just the unit ones");
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "send_to_agent", arguments: '{"utterances":2}' });
    await flush();
    await flush();
    say(upstream, "u3", "and then lint");
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "c2", name: "send_to_agent", arguments: '{"utterances":3}' });
    await flush();
    await flush();
    const texts = harness.sdk.callsTo("threads.send").map((c) => (c[0] as { input: { text: string }[] }).input[0]!.text);
    expect(texts).toEqual(["run the tests\njust the unit ones", "and then lint"]);
  });

  it("asks the user to repeat when their words couldn't be transcribed", async () => {
    const { harness, upstream } = await liveSession();
    say(upstream, "u1", null);
    upstream.emit({ type: "conversation.item.input_audio_transcription.failed", item_id: "u1" });
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "c", name: "send_to_agent", arguments: "{}" });
    await flush();
    await flush();
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
    const output = (upstream.ofType("conversation.item.create").at(-1) as { item: { output: string } }).item.output;
    expect(output).toMatch(/couldn't be transcribed/);
  });

  it("allows one send_to_agent per thing the user says", async () => {
    const { harness, upstream } = await liveSession();
    const call = (id: string) =>
      upstream.emit({ type: "response.function_call_arguments.done", call_id: id, name: "send_to_agent", arguments: "{}" });
    call("unprompted");
    say(upstream, "u1");
    call("first");
    call("second");
    await flush();
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    const outputs = upstream.ofType("conversation.item.create").slice(1) as { item: { call_id: string; output: string } }[];
    expect(outputs.find((o) => o.item.call_id === "unprompted")!.item.output).toMatch(/^Not sent/);
    expect(outputs.find((o) => o.item.call_id === "second")!.item.output).toMatch(/^Not sent/);
  });

  it("keeps one live session per bb server", async () => {
    const { harness, toBrowser } = await liveSession();
    await harness.experimental_openWebSocket(`/session?threadId=thr_other`);
    await flush();
    expect(toBrowser().some((m) => m.type === "ENDED")).toBe(true);
  });

  it("interrupts playback and trims the reply when the user talks over it", async () => {
    const { upstream, toBrowser } = await liveSession();
    upstream.emit({ type: "response.created" });
    upstream.emit({ type: "response.output_audio.delta", item_id: "item_1", delta: "A".repeat(64000) });
    upstream.emit({ type: "input_audio_buffer.speech_started" });
    expect(toBrowser().filter((m) => m.type === "INTERRUPTION")).toHaveLength(1);
    expect(upstream.ofType("conversation.item.truncate")[0]).toMatchObject({ item_id: "item_1", content_index: 0 });
  });

  it("ends a session nobody has talked in for five minutes, but not while the agent works", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { upstream, toBrowser } = await liveSession();
      say(upstream, "u1");
      upstream.emit({ type: "response.created" });
      upstream.emit({ type: "response.function_call_arguments.done", call_id: "c", name: "send_to_agent", arguments: "{}" });
      upstream.emit({ type: "response.done" });
      await vi.advanceTimersByTimeAsync(0);
      upstream.emit({ type: "response.done" }); // the spoken follow-up
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      expect(toBrowser().some((m) => m.type === "ENDED")).toBe(false);
      // ...but not forever: a hung agent turn ends it after 20 quiet minutes.
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(toBrowser().some((m) => m.type === "ENDED")).toBe(true);

      const next = await liveSession();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(next.toBrowser().some((m) => m.type === "ENDED")).toBe(false);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(next.toBrowser().some((m) => m.type === "ENDED")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agent turns", () => {
  async function liveSession(options: Parameters<typeof startSession>[0] = {}) {
    const session = await startSession({ settings: { openaiApiKey: "sk-test" }, ...options });
    const upstream = FakeUpstream.last!;
    upstream.open();
    upstream.emit({ type: "session.updated" });
    return { ...session, upstream };
  }
  const thread = (status: "idle" | "active" | "error") => makeThreadResponse({ id: THREAD, status });
  const userTexts = (upstream: FakeUpstream) =>
    (upstream.ofType("conversation.item.create") as { item: { role?: string; content?: { text: string }[] } }[])
      .filter((m) => m.item.role === "user")
      .map((m) => m.item.content![0]!.text);

  it("reports a finished turn as a [bb update] the model can only talk about", async () => {
    const { harness, upstream } = await liveSession();
    await harness.emitThreadEvent("thread.active", { thread: thread("active") });
    await harness.emitThreadEvent("thread.idle", { thread: thread("idle"), lastAssistantText: "All 40 tests pass." });
    expect(userTexts(upstream).at(-1)).toMatch(/^\[bb update\] The agent finished.*All 40 tests pass/);
    expect(upstream.ofType("response.create")).toEqual([{ type: "response.create", response: { tool_choice: "none" } }]);
  });

  it("reports a turn that starts and ends between status reads", async () => {
    // Transition events, not polling: nothing to miss even if both land at once.
    const { harness, upstream } = await liveSession();
    await Promise.all([
      harness.emitThreadEvent("thread.active", { thread: thread("active") }),
      harness.emitThreadEvent("thread.idle", { thread: thread("idle"), lastAssistantText: "Done." }),
    ]);
    expect(userTexts(upstream).some((t) => t.includes("Done."))).toBe(true);
  });

  it("ignores events for other threads", async () => {
    const { harness, upstream } = await liveSession();
    await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_other", status: "active" }) });
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_other", status: "idle" }), lastAssistantText: "x" });
    expect(upstream.ofType("response.create")).toHaveLength(0);
  });

  it("tells the user when the agent is waiting on them, and stops holding the session open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { harness, upstream, toBrowser } = await liveSession();
      await harness.emitThreadEvent("thread.active", { thread: thread("active") });
      await harness.emitThreadEvent("interaction.pending", { thread: thread("active"), interaction: {} as never });
      expect(userTexts(upstream).at(-1)).toMatch(/answer it in bb/);
      expect(toBrowser()).toContainEqual({ type: "AGENT_STATUS", status: "waiting for you" });
      upstream.emit({ type: "response.done" });
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000);
      expect(toBrowser().some((m) => m.type === "ENDED")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes a pending question in get_agent_status", async () => {
    const { upstream } = await liveSession({ interactions: [{ id: "int_1" }], thread: { status: "active" } });
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "s", name: "get_agent_status", arguments: "" });
    await flush();
    const output = (upstream.ofType("conversation.item.create") as { item: { call_id?: string; output?: string } }[]).find((m) => m.item.call_id === "s");
    expect(output!.item.output).toMatch(/waiting for the user/);
  });

  it("answers a tool that finishes while another response is playing", async () => {
    const { upstream } = await liveSession();
    upstream.emit({ type: "response.created" });
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "a", name: "get_agent_status", arguments: "" });
    upstream.emit({ type: "response.done" });
    await flush();
    expect(upstream.ofType("response.create")).toHaveLength(1);
    // The user asks again while the follow-up plays; its tool lands mid-response.
    upstream.emit({ type: "response.created" });
    upstream.emit({ type: "response.function_call_arguments.done", call_id: "b", name: "get_agent_status", arguments: "" });
    await flush();
    expect(upstream.ofType("response.create")).toHaveLength(1);
    upstream.emit({ type: "response.done" });
    expect(upstream.ofType("response.create")).toHaveLength(2);
  });

  it("trims a reply the user talks over after generation finished, but not one already played", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const { upstream } = await liveSession();
      upstream.emit({ type: "response.created" });
      // 64000 base64 chars = 48000 bytes = 1000 ms of 24 kHz PCM16.
      upstream.emit({ type: "response.output_audio.delta", item_id: "item_1", delta: "A".repeat(64000) });
      upstream.emit({ type: "response.done" });
      await vi.advanceTimersByTimeAsync(400);
      upstream.emit({ type: "input_audio_buffer.speech_started" });
      expect(upstream.ofType("conversation.item.truncate")).toEqual([
        { type: "conversation.item.truncate", item_id: "item_1", content_index: 0, audio_end_ms: 400 },
      ]);

      upstream.emit({ type: "response.created" });
      upstream.emit({ type: "response.output_audio.delta", item_id: "item_2", delta: "A".repeat(64000) });
      upstream.emit({ type: "response.done" });
      await vi.advanceTimersByTimeAsync(2000);
      upstream.emit({ type: "input_audio_buffer.speech_started" });
      expect(upstream.ofType("conversation.item.truncate")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["auto", "plugin"])("handles a failed connection refresh in %s mode", async (connection) => {
    const { harness, toBrowser } = await startSession({
      settings: { connection, openaiApiKey: "sk-test" },
      connectionPlugin: true,
      refreshError: new Error("Proxy token refresh failed"),
    });
    const first = FakeUpstream.last!;
    first.onerror?.();
    await flush();
    expect(harness.sdk.callsTo("plugins.callRpc").map((c) => (c[0] as { input: unknown }).input)).toEqual([{}, { refresh: true }]);
    if (connection === "auto") {
      expect(FakeUpstream.last).not.toBe(first);
      expect(FakeUpstream.last!.url).toBe("wss://api.openai.com/v1/realtime?model=gpt-realtime-2");
      expect(FakeUpstream.last!.init.headers).toEqual({ authorization: "Bearer sk-test" });
      FakeUpstream.last!.onerror?.();
      await flush();
      expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(2);
      expect(toBrowser()[0]).toMatchObject({ type: "ERROR", message: "Voice connection failed" });
    } else {
      expect(FakeUpstream.last).toBe(first);
      expect(toBrowser()[0]).toMatchObject({ type: "ERROR", message: expect.stringMatching(/Proxy token refresh failed/) });
    }
  });

  it("asks a connection plugin for a fresh credential once when the handshake fails", async () => {
    const { harness } = await startSession({ connectionPlugin: true });
    const first = FakeUpstream.last!;
    first.onerror?.();
    await flush();
    expect(FakeUpstream.last).not.toBe(first);
    expect(harness.sdk.callsTo("plugins.callRpc").map((c) => (c[0] as { input: unknown }).input)).toEqual([{}, { refresh: true }]);
    const second = FakeUpstream.last!;
    second.onerror?.();
    await flush();
    expect(FakeUpstream.last).toBe(second);
  });
});

describe("GPT-Live project key mode", () => {
  async function openLive() {
    const session = await startSession({
      connectionPlugin: true,
      settings: { connection: "openai-live", openaiApiKey: "test-key", prefixMessages: true },
    });
    const socket = FakeUpstream.last!;
    socket.open();
    return { ...session, socket };
  }
  const ready = { type: "session.started" };
  const delegation = { type: "session.delegation.created", event_id: "event-d", offset_ms: 1200, delegation: { id: "d", target: "client" } };
  const words = { type: "session.input_transcript.delta", event_id: "t1", start_ms: 100, end_ms: 350, delta: "Проверь " };
  const mic = JSON.stringify({ type: "AUDIO", base64Data: "AAA=" });

  it("requires a project key even with a working subscription connection", async () => {
    const { toBrowser } = await startSession({ connectionPlugin: true, settings: { connection: "openai-live" } });
    expect(FakeUpstream.last).toBeNull();
    expect(toBrowser()).toContainEqual({ type: "ERROR", message: expect.stringContaining("project API key") });
  });

  it("opens Live directly, waits for readiness, relays PCM both ways and closes on END", async () => {
    const { socket, browser, toBrowser, harness } = await openLive();
    expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    expect(socket.url).toBe("wss://api.openai.com/v1/live/sessions");
    expect(socket.init.headers).toEqual({ authorization: "Bearer test-key" });
    expect(socket.sent).toEqual([expect.objectContaining({ type: "session.start", session: expect.objectContaining({
      model: "gpt-live-1", delegation: { type: "client" }, audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
    }) })]);
    await browser.receive(mic);
    expect(socket.ofType("session.input_audio.append")).toHaveLength(0);
    socket.emit(ready);
    expect(toBrowser()).toContainEqual({ type: "READY", inputHz: 24000, outputHz: 24000, badge: "Live" });
    await browser.receive(mic);
    expect(socket.ofType("session.input_audio.append")).toEqual([{ type: "session.input_audio.append", audio: "AAA=" }]);
    socket.emit({ type: "session.output_audio.delta", delta: "AQI=" });
    expect(toBrowser()).toContainEqual({ type: "AUDIO", base64Data: "AQI=" });
    await browser.receive(JSON.stringify({ type: "CLIENT_READY" }));
    await browser.receive(JSON.stringify({ type: "CLIENT_READY" }));
    expect(socket.ofType("session.commentary.append")).toHaveLength(1);
    await browser.receive(JSON.stringify({ type: "END" }));
    expect(socket.ofType("session.close")).toHaveLength(1);
    socket.emit({ type: "session.closed", reason: "close_requested" });
    expect(socket.readyState).toBe(3);
  });

  it("correlates late and duplicate transcript fragments, forwards once and reports the result against its delegation", async () => {
    const { socket, harness, browser } = await openLive();
    vi.useFakeTimers();
    try {
      socket.emit(ready);
      socket.emit(delegation);
      socket.emit({ ...words, event_id: "t2", start_ms: 350, end_ms: 780, delta: "сборку" });
      socket.emit(words);
      socket.emit(words);
      socket.emit({ ...words, event_id: "later", start_ms: 2000, end_ms: 3000, delta: "другое поручение" });
      socket.emit({ ...delegation, event_id: "duplicate" });
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
      expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
        threadId: THREAD, input: [{ text: "[Voice Mode] Проверь сборку" }],
      });
      await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: THREAD, status: "active" }) });
      await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: THREAD, status: "idle" }), lastAssistantText: "Сборка прошла." });
      expect(socket.ofType("session.commentary.append").at(-1)).toMatchObject({ delegation_id: "d", content: expect.stringContaining("Сборка прошла.") });
      expect(socket.ofType("response.create")).toHaveLength(0);
    } finally {
      await browser.close();
      socket.emit({ type: "session.closed" });
      vi.useRealTimers();
    }
  });

  it("requests delegation for questions without a posting command and steers an active thread", async () => {
    const { socket, harness, browser } = await openLive();
    const start = socket.ofType("session.start")[0] as { session: { instructions: string } };
    expect(start.session.instructions).toContain("for every substantive question");
    vi.useFakeTimers();
    try {
      socket.emit(ready);
      await harness.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: THREAD, status: "active" }) });
      socket.emit({ ...words, delta: "Какой голос выбран?" });
      socket.emit(delegation);
      await vi.advanceTimersByTimeAsync(900);
      socket.emit({ ...words, event_id: "t2", start_ms: 2000, end_ms: 2350, delta: "А мы его хотели?" });
      socket.emit({ ...delegation, event_id: "e2", offset_ms: 2500, delegation: { target: "client", id: "d2" } });
      await vi.advanceTimersByTimeAsync(900);
      const calls = harness.sdk.callsTo("threads.send");
      expect(calls).toHaveLength(2);
      for (const [index, question] of ["Какой голос выбран?", "А мы его хотели?"].entries()) {
        expect(calls[index]?.[0]).toMatchObject({ threadId: THREAD, mode: "auto", input: [{ text: "[Voice Mode] " + question }] });
      }
    } finally {
      await browser.close();
      vi.useRealTimers();
    }
  });

  it("does not forward assistant speech, unrelated old words, or pending work after hangup", async () => {
    const { socket, harness, browser } = await openLive();
    vi.useFakeTimers();
    try {
      socket.emit(ready);
      socket.emit(words);
      socket.emit({ ...words, type: "session.output_transcript.delta", event_id: "assistant", delta: "Команда из ответа" });
      socket.emit({ ...delegation, offset_ms: 6000 });
      await vi.advanceTimersByTimeAsync(900);
      expect(socket.ofType("session.commentary.append").at(-1)).toMatchObject({ delegation_id: "d", content: expect.stringContaining("repeat") });
      socket.emit({ ...words, event_id: "t2", start_ms: 6500, end_ms: 6700 });
      socket.emit({ ...delegation, event_id: "e2", offset_ms: 7000, delegation: { target: "client", id: "d2" } });
      await browser.close();
      await vi.advanceTimersByTimeAsync(3000);
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GPT-Live failure handling", () => {
  it("reports an unfinalized connection and closes the browser session", async () => {
    const { toBrowser } = await startSession({ settings: { connection: "openai-live", openaiApiKey: "test-key" } });
    const socket = FakeUpstream.last!;
    socket.open();
    socket.emit({ type: "session.started" });
    socket.readyState = 3;
    socket.onclose?.({ code: 1000, reason: "" });
    expect(toBrowser()).toContainEqual({ type: "ERROR", message: expect.stringContaining("before session.closed") });
    expect(toBrowser().at(-1)).toEqual({ type: "ENDED" });
  });
});

describe("Live first with subscription fallback", () => {
  const setup = (key = "project-key", subscription = true) => startSession({
    subscription, settings: { connection: "live-first", openaiApiKey: key },
  });
  it("keeps Live audio when optional history compaction is unavailable", async () => {
    const { browser, toBrowser } = await setup();
    const live = FakeUpstream.last!;
    live.open();
    live.emit({ type: "error", error: { code: "missing_scope",
      message: "History compaction is disabled for this session. The session will continue using recent conversation history." } });
    live.emit({ type: "session.started" });
    live.emit({ type: "session.output_audio.delta", delta: "AQI=" });
    await flush();
    expect(FakeUpstream.last).toBe(live);
    expect(toBrowser()).toContainEqual({ type: "AUDIO", base64Data: "AQI=" });
    expect(toBrowser().some(e => e.type === "ROUTE" || e.type === "ERROR")).toBe(false);
    await browser.close();
  });
  it("switches on a missing required Live scope", async () => {
    const { browser } = await setup();
    const live = FakeUpstream.last!;
    live.open();
    live.emit({ type: "error", error: { code: "missing_scope", message: "Missing Live write permission." } });
    await flush();
    expect(FakeUpstream.last!.url).toMatch(/gpt-realtime-2\.1$/);
    await browser.close();
  });
  it("uses only the subscription route when the key is missing", async () => {
    const { toBrowser, browser } = await setup("");
    const rt = FakeUpstream.last!;
    expect(rt.url).toMatch(/gpt-realtime-2\.1$/);
    expect(rt.init.headers?.authorization).toBe("Bearer proxy-token");
    rt.open(); rt.emit({ type: "session.updated" });
    expect(toBrowser().filter(e => e.type === "ROUTE")).toHaveLength(2);
    await browser.close();
  });
  it.each([false,true])("falls back exactly once on a credit error (already ready = %s) and retries Live on next call", async started => {
    const { toBrowser, browser } = await setup();
    const live = FakeUpstream.last!;
    expect(live.url).toMatch(/live\/sessions$/);
    live.open();
    if (started) live.emit({ type: "session.started" });
    live.emit({ type: "error", error: { code: "credit_balance_exhausted" } });
    live.onclose?.({ code: 1006, reason: "" });
    await flush();
    const rt = FakeUpstream.last!;
    expect(rt.url).toMatch(/gpt-realtime-2\.1$/);
    rt.open(); rt.emit({ type: "session.updated" });
    live.emit({ type: "session.output_audio.delta", delta: "stale" });
    await browser.receive(JSON.stringify({ type: "AUDIO", base64Data: "AQI=" }));
    expect(rt.ofType("input_audio_buffer.append")).toHaveLength(1);
    expect(toBrowser().filter(e => e.type === "READY")).toHaveLength(1);
    expect(toBrowser().some(e => e.type === "ENDED" || e.base64Data === "stale")).toBe(false);
    expect(toBrowser()).toContainEqual({ type: "ROUTE", switching: false, message: "Connected to Realtime 2.1" });
    await browser.close();
    const next = await setup();
    expect(FakeUpstream.last!.url).toMatch(/live\/sessions$/);
    await next.browser.close();
  });
  it("reports a missing fallback without switching to metered Realtime", async () => {
    const { toBrowser } = await setup("", false);
    expect(toBrowser()).toContainEqual({ type: "ERROR", message: expect.stringContaining("gpt-realtime-2.1") });
    expect(FakeUpstream.last).toBeNull();
  });
  it("does not retry content terminations or intentional hangups", async () => {
    const { toBrowser } = await setup();
    const socket = FakeUpstream.last!;
    socket.open(); socket.emit({ type: "session.started" });
    socket.emit({ type: "session.closed", reason: "content" });
    await flush();
    expect(FakeUpstream.last).toBe(socket);
    expect(toBrowser().some(e => e.type === "ROUTE")).toBe(false);
  });
  it("switches on an interrupted transport and deadline, never after the user hangs up", async () => {
    const session = await setup();
    const first = FakeUpstream.last!;
    first.onerror?.(); await flush();
    expect(FakeUpstream.last!.url).toMatch(/gpt-realtime-2\.1$/);
    await session.browser.close();
    const next = await setup();
    const second = FakeUpstream.last!;
    await next.browser.close();
    second.onerror?.(); await flush();
    expect(FakeUpstream.last).toBe(second);
  });
});


it("starts 1.1 through Codex without a key and retains the subscription fallback", async () => {
  const { toBrowser, browser } = await startSession({ subscription: true, settings: { connection: "codex-live-first" } });
  const first = FakeUpstream.last!;
  expect(first.url).toBe("codex-app-server");
  first.open();
  expect(first.ofType("session.start")[0]).toMatchObject({ session: { model: "gpt-live-1.1-codex" } });
  first.emit({ type: "session.started" });
  expect(toBrowser()).toContainEqual({ type: "READY", inputHz: 24000, outputHz: 24000, badge: "Live 1.1" });
  first.onclose?.({code:1006, reason:"disconnected"});
  await flush();
  expect(FakeUpstream.last!.url).toMatch(/gpt-realtime-2\.1$/);
  expect(toBrowser().filter(e => e.type === "READY")).toHaveLength(1);
  await browser.close();
});
