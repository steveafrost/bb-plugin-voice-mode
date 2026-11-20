import { afterEach, expect, it, vi } from "vitest";
import { Audibility, Player, workletSource } from "../audio";

afterEach(() => vi.unstubAllGlobals());

const RATE = 24000;
const chunk = (ms: number, value = 8000) => {
  const pcm = new Int16Array((RATE * ms) / 1000).fill(value);
  return Buffer.from(pcm.buffer).toString("base64");
};

/** A fake AudioContext without AudioWorklet, so Player uses its ScriptProcessor fallback. */
function scriptContext() {
  const state = { now: 0, processor: null as null | { onaudioprocess: ((e: unknown) => void) | null } };
  class Context {
    sampleRate = RATE;
    destination = {};
    get currentTime() { return state.now; }
    createScriptProcessor() {
      const p = { onaudioprocess: null, connect() {}, disconnect() {} };
      state.processor = p;
      return p;
    }
    close() { return Promise.resolve(); }
  }
  /** Renders `frames` samples at the current time and returns them. */
  const render = (frames = 2048) => {
    const out = new Float32Array(frames);
    state.processor!.onaudioprocess!({ outputBuffer: { getChannelData: () => out } });
    state.now += frames / RATE;
    return out;
  };
  return { Context, state, render };
}

it("plays through the ScriptProcessor fallback, reports audibility, and goes silent on interrupt", async () => {
  const { Context, render } = scriptContext();
  vi.stubGlobal("AudioContext", Context);
  const player = new Player(RATE);
  expect(await player.ready).toBe("script");
  const active = vi.fn();
  const idle = vi.fn();
  player.onActive = active;
  player.onIdle = idle;
  for (let i = 0; i < 25; i++) player.enqueue(chunk(20), i * 480);
  let audible = 0;
  for (let i = 0; i < 6; i++) audible += render().filter((x) => Math.abs(x) > 0.1).length;
  // 500 ms queued, 150 ms start-up reserve, 512 ms rendered.
  expect(audible / RATE).toBeGreaterThan(0.35);
  expect(active).toHaveBeenCalledTimes(1);
  expect(player.playing).toBe(true);
  player.interrupt();
  expect(idle).toHaveBeenCalledTimes(1);
  expect(player.level()).toBe(0);
  const after = render();
  expect(after.slice(200).every((x) => x === 0)).toBe(true);
  // The model may keep talking after the interruption: that is reported again.
  for (let i = 0; i < 25; i++) player.enqueue(chunk(20), 20000 + i * 480);
  for (let i = 0; i < 4; i++) render();
  expect(active).toHaveBeenCalledTimes(2);
});

it("treats empty audio with a position as the start of a pause, not as an underrun", async () => {
  const { Context, render } = scriptContext();
  vi.stubGlobal("AudioContext", Context);
  const player = new Player(RATE);
  await player.ready;
  for (let i = 0; i < 10; i++) player.enqueue(chunk(20), i * 480);
  player.enqueue("", 4800);
  for (let i = 0; i < 4; i++) render();
  expect((await player.stats()).underruns).toBe(0);
});

it("keeps the old back-to-back behaviour for audio without positions", async () => {
  const { Context, render } = scriptContext();
  vi.stubGlobal("AudioContext", Context);
  const player = new Player(RATE);
  await player.ready;
  player.enqueue(chunk(500));
  const out = render(24000);
  const first = out.findIndex((x) => x !== 0);
  expect(first / RATE).toBeCloseTo(0.14, 2);
  // Only the 3 ms fade-in is quieter.
  expect(out.slice(first + 72, first + 11800).every((x) => x > 0.2)).toBe(true);
});

it("ships a self-contained worklet that plays, flushes and posts audibility", () => {
  const posted: unknown[] = [];
  const processors = new Map<string, new () => { port: { onmessage: (e: { data: unknown }) => void }; process(i: unknown, o: Float32Array[][]): boolean }>();
  class AudioWorkletProcessor {
    port = { onmessage: (_e: { data: unknown }) => {}, postMessage: (m: unknown) => posted.push(m) };
  }
  const scope = { sampleRate: RATE, currentFrame: 0 };
  const load = new Function("AudioWorkletProcessor", "registerProcessor", "scope",
    `with (scope) { ${workletSource()} }`);
  load(AudioWorkletProcessor, (name: string, cls: never) => processors.set(name, cls), scope);
  expect([...processors.keys()].sort()).toEqual(["bb-voice-mic", "bb-voice-player"]);
  const player = new (processors.get("bb-voice-player")!)();
  const frame = new Float32Array(480).fill(0.5);
  for (let i = 0; i < 20; i++) player.port.onmessage({ data: { t: "pcm", d: frame.slice(), p: i * 480 } });
  let loud = 0;
  for (let q = 0; q < 100; q++) {
    const out = [[new Float32Array(128)]];
    player.process([], out);
    scope.currentFrame += 128;
    loud += out[0][0].filter((x) => x > 0.4).length;
  }
  expect(loud).toBeGreaterThan(9000);
  expect(posted).toContainEqual({ t: "audible", on: true });
  player.port.onmessage({ data: { t: "flush" } });
  const out = [[new Float32Array(128)]];
  player.process([], out);
  expect(out[0][0].slice(100).every((x) => x === 0)).toBe(true);
});

it("needs sustained quiet before reporting the voice idle", () => {
  const a = new Audibility(RATE * 0.35, 0.004);
  expect(a.update(0.1, 128)).toBe(true);
  for (let i = 0; i < 60; i++) expect(a.update(0, 128)).toBe(false);
  let changed = false;
  for (let i = 0; i < 10; i++) changed ||= a.update(0, 128);
  expect(changed).toBe(true);
  expect(a.audible).toBe(false);
});
