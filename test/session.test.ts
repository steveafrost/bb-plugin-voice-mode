import { afterEach, expect, it, vi } from "vitest";
import type { ServerToBrowser } from "../server";
import { BARGE_IN_CHUNKS } from "../audio";
import { VoiceSession } from "../session";

const audio = vi.hoisted(() => ({
  enqueue: vi.fn(),
  startMic: vi.fn(),
  player: null as {
    playing: boolean;
    onActive: (() => void) | null;
    onIdle: (() => void) | null;
  } | null,
}));

vi.mock("../audio", () => ({
  BARGE_IN_CHUNKS: 5,
  BARGE_IN_RMS: 0.04,
  startMic: audio.startMic,
  Player: class {
    readonly ready = Promise.resolve("worklet");
    playing = false;
    onActive: (() => void) | null = null;
    onIdle: (() => void) | null = null;
    enqueue = audio.enqueue;
    constructor() { audio.player = this; }
    interrupt() {
      if (!this.playing) return;
      this.playing = false;
      this.onIdle?.();
    }
    async close() {}
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function start() {
  let browser!: Socket;
  class Socket {
    static OPEN = 1;
    readyState = Socket.OPEN;
    onmessage!: (event: { data: string }) => Promise<void>;
    send = vi.fn();
    close() {}
    constructor() { browser = this; }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", { location: { href: "http://localhost" } });
  let mic!: (pcm: string, rms: number) => void;
  audio.startMic.mockImplementation(async (_rate, _isMuted, onChunk) => {
    mic = onChunk;
    return async () => {};
  });

  const session = new VoiceSession("thr_test");
  await session.start();
  const receive = (message: ServerToBrowser) => browser.onmessage({ data: JSON.stringify(message) });
  await receive({ type: "READY", inputHz: 24000, outputHz: 24000 });
  const playback = audio.player!;
  const activate = () => {
    playback.playing = true;
    playback.onActive?.();
  };
  const say = (rms: number) => mic("input", rms);
  const receiveAudio = (frame: string, pts?: number) => receive({ type: "AUDIO", base64Data: frame, pts });
  return { session, receive, receiveAudio, activate, say };
}

it("waits for audible output and resumes after two quiet mic chunks following barge-in", async () => {
  const { session, receiveAudio, activate, say } = await start();
  const phases: string[] = [];
  session.subscribe(() => phases.push(session.getState().phase));
  await receiveAudio("first", 480);
  expect(audio.enqueue).toHaveBeenLastCalledWith("first", 480);
  expect(session.getState().phase).toBe("listening");
  activate();
  for (let i = 0; i < BARGE_IN_CHUNKS; i++) say(0.1);
  await receiveAudio("dropped");
  say(0);
  await receiveAudio("also dropped");
  expect(audio.enqueue).toHaveBeenCalledTimes(1);
  say(0);
  await receiveAudio("next");
  expect(audio.enqueue).toHaveBeenLastCalledWith("next", undefined);
  activate();
  expect(phases).toEqual(["speaking", "listening", "speaking"]);
  await session.stop();
});

it("does not flash speaking when mic speech starts while assistant audio is buffering", async () => {
  const { session, receive, receiveAudio, activate, say } = await start();
  const phases: string[] = [];
  session.subscribe(() => phases.push(session.getState().phase));
  await receiveAudio("buffering");
  for (let i = 0; i < BARGE_IN_CHUNKS; i++) say(0.1);
  activate();
  expect(phases).toEqual([]);
  await receiveAudio("dropped");
  expect(audio.enqueue).toHaveBeenCalledTimes(1);

  await receive({ type: "INTERRUPTION" });
  say(0);
  await receiveAudio("new response");
  activate();
  expect(phases).toEqual(["speaking"]);
  await session.stop();
});
