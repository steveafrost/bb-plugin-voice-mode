import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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

beforeEach(() => {
  FakeUpstream.last = null;
  vi.stubGlobal("WebSocket", Object.assign(FakeUpstream, { OPEN: 1 }));
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function startSession(options: { settings?: Record<string, string>; connectionPlugin?: boolean }) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "voice-mode",
    settings: options.settings ?? {},
    sdk: {
      threads: {
        get: async () => ({ status: "idle", title: "Fix the build" }),
        output: async () => ({ output: "Build is green." }),
        send: async () => ({}),
        stop: async () => ({}),
      },
      subscribe: () => () => {},
      plugins: {
        experimental_discoverRpc: async () =>
          options.connectionPlugin ? [{ pluginId: "shopify-ai", method: "realtimeConnection" }] : [],
        callRpc: async () => ({
          protocol: "openai-realtime",
          url: "wss://proxy.example.com/v1/realtime?model=gpt-realtime-mini",
          headers: { authorization: "Bearer proxy-token" },
          model: "gpt-realtime-mini",
        }),
      },
    } as never,
  });
  plugin(bb);
  const browser = await harness.experimental_openWebSocket(`/session?threadId=${THREAD}`);
  await flush();
  const toBrowser = () => browser.sent.map((m) => JSON.parse(String(m)) as Record<string, unknown>);
  return { harness, browser, toBrowser };
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

  it("ignores connection plugins when set to the API key", async () => {
    await startSession({ settings: { openaiApiKey: "sk-test", connection: "openai-api-key" }, connectionPlugin: true });
    expect(FakeUpstream.last!.url).toContain("api.openai.com");
  });

  it("explains the setup when there is neither a key nor a connection plugin", async () => {
    const { toBrowser } = await startSession({});
    expect(FakeUpstream.last).toBeNull();
    expect(toBrowser()[0]).toMatchObject({ type: "ERROR", message: expect.stringMatching(/OpenAI API key/) });
  });
});

describe("session", () => {
  async function liveSession() {
    const session = await startSession({ settings: { openaiApiKey: "sk-test", voice: "cedar" } });
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
    expect(update!.session.instructions).toContain("Fix the build");
    expect(toBrowser()).toContainEqual({ type: "READY", inputHz: 24000, outputHz: 24000 });
  });

  it("relays mic audio upstream", async () => {
    const { browser, upstream } = await liveSession();
    await browser.receive(JSON.stringify({ type: "AUDIO", base64Data: "AAAA" }));
    expect(upstream.ofType("input_audio_buffer.append")).toEqual([{ type: "input_audio_buffer.append", audio: "AAAA" }]);
  });

  it("runs send_to_agent against the thread and asks for a reply after the response ends", async () => {
    const { harness, upstream } = await liveSession();
    upstream.emit({ type: "response.created" });
    upstream.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "send_to_agent",
      arguments: JSON.stringify({ text: "Run the tests" }),
    });
    upstream.emit({ type: "response.done" });
    await flush();
    await flush();
    expect(harness.sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
      threadId: THREAD,
      input: [{ type: "text", text: "Run the tests" }],
    });
    expect(upstream.ofType("conversation.item.create")[0]).toMatchObject({
      item: { type: "function_call_output", call_id: "call_1" },
    });
    expect(upstream.ofType("response.create")).toHaveLength(1);
  });

  it("interrupts playback and trims the reply when the user talks over it", async () => {
    const { upstream, toBrowser } = await liveSession();
    upstream.emit({ type: "response.created" });
    upstream.emit({ type: "response.output_audio.delta", item_id: "item_1", delta: "A".repeat(64000) });
    upstream.emit({ type: "input_audio_buffer.speech_started" });
    expect(toBrowser().filter((m) => m.type === "INTERRUPTION")).toHaveLength(1);
    expect(upstream.ofType("conversation.item.truncate")[0]).toMatchObject({ item_id: "item_1", content_index: 0 });
  });
});
