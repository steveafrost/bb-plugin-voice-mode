import { describe, expect, it } from "vitest";
import { JitterBuffer } from "../jitter";

const RATE = 24000;
const FRAME = 480; // 20 ms

type Arrival = { at: number; pts: number | null; n?: number; end?: boolean; level?: number };

/** Feeds arrivals (times in ms) and renders 128-sample quanta until `untilMs`. */
function run(arrivals: Arrival[], untilMs: number, actions: { at: number; act: (jb: JitterBuffer) => void }[] = []) {
  const jb = new JitterBuffer(RATE);
  const total = Math.round((untilMs / 1000) * RATE);
  const out = new Float32Array(total);
  const events = [...arrivals].sort((a, b) => a.at - b.at);
  let e = 0;
  let a = 0;
  for (let t = 0; t < total; t += 128) {
    while (e < events.length && (events[e].at / 1000) * RATE <= t) {
      const x = events[e++];
      if (x.end) jb.end(x.pts!, t);
      else jb.push(new Float32Array(x.n ?? FRAME).fill(x.level ?? 0.5), x.pts, t);
    }
    while (a < actions.length && (actions[a].at / 1000) * RATE <= t) actions[a++].act(jb);
    jb.render(out.subarray(t, Math.min(total, t + 128)), t);
  }
  return { jb, out };
}

/** Silent runs (|x| < 1e-3) of at least 2 ms strictly between audible samples. */
function holes(out: Float32Array) {
  const runs: { start: number; len: number }[] = [];
  let first = out.findIndex((x) => Math.abs(x) >= 1e-3);
  if (first < 0) return runs;
  let start = -1;
  for (let i = first; i < out.length; i++) {
    const silent = Math.abs(out[i]) < 1e-3;
    if (silent && start < 0) start = i;
    if (!silent && start >= 0) {
      if (i - start >= 48) runs.push({ start, len: i - start });
      start = -1;
    }
  }
  return runs;
}

const firstSound = (out: Float32Array) => out.findIndex((x) => Math.abs(x) >= 1e-3);

/**
 * Continuous speech: one 20 ms frame per 20 ms, with the given extra delay per
 * frame. The WebSocket is ordered, so a frame never arrives before its predecessor.
 */
function speech(frames: number, delay: (i: number) => number, from = 0, ptsFrom = 0, level = 0.5): Arrival[] {
  let last = -Infinity;
  const out: Arrival[] = Array.from({ length: frames }, (_, i) => {
    last = Math.max(last, from + i * 20 + delay(i));
    return { at: last, pts: ptsFrom + i * FRAME, level };
  });
  // The bridge marks the silence after the last word.
  out.push({ at: last, pts: ptsFrom + frames * FRAME, end: true });
  return out;
}

describe("JitterBuffer", () => {
  it("plays real-time frames with up to 80 ms of jitter without a gap", () => {
    // Deterministic pseudo-random jitter in [0, 80) ms.
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const { out, jb } = run(speech(400, () => rand() * 80), 9000);
    expect(holes(out)).toEqual([]);
    expect(jb.stats.underruns).toBe(0);
    expect(jb.target / RATE).toBeGreaterThan(0.08);
    expect(jb.target / RATE).toBeLessThanOrEqual(0.25);
  });

  it("starts the first spurt after its start-up reserve, not later", () => {
    const { out } = run(speech(50, () => 0), 2000);
    const start = firstSound(out) / RATE;
    expect(start).toBeGreaterThan(0.13);
    expect(start).toBeLessThan(0.17);
  });

  it("treats a marked pause as silence, keeps its length, and does not count an underrun", () => {
    const first = speech(50, () => 0);
    // 600 ms of silence that the sender does not transmit.
    const second = speech(50, () => 0, 1600, 80 * FRAME);
    const { out, jb } = run([...first, ...second], 3500);
    expect(jb.stats.underruns).toBe(0);
    const gaps = holes(out);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].len / RATE).toBeCloseTo(0.6, 2);
  });

  it("conceals a late frame with a short fade, then rebuilds its reserve", () => {
    // Frame 100 and later arrive 300 ms late at once (a stall then a burst).
    const { out, jb } = run(speech(200, (i) => (i >= 100 && i < 115 ? 300 - (i - 100) * 20 : 0)), 5000);
    expect(jb.stats.underruns).toBe(1);
    const gaps = holes(out);
    expect(gaps).toHaveLength(1);
    // No click: the samples next to the gap ramp instead of jumping.
    const { start, len } = gaps[0];
    expect(Math.abs(out[start - 1])).toBeLessThan(0.05);
    expect(Math.abs(out[start + len])).toBeLessThan(0.05);
    // Nothing played twice or lost: total audible time equals what was sent.
    const audible = out.reduce((n, x) => n + (Math.abs(x) >= 1e-3 ? 1 : 0), 0);
    expect(audible / RATE).toBeGreaterThan(3.95);
    expect(audible / RATE).toBeLessThanOrEqual(4.0);
  });

  it("raises its target after jitter so the same stall does not repeat as a gap", () => {
    const late = (i: number) => (i % 100 === 50 ? 120 : 0);
    const { jb } = run(speech(400, late), 9000);
    // The first spike underruns at the start-up reserve; later ones are absorbed.
    expect(jb.stats.underruns).toBeLessThanOrEqual(1);
    expect(jb.target / RATE).toBeGreaterThanOrEqual(0.14);
  });

  it("catches up after a stall by shortening the following pauses", () => {
    // Speech with a pause every second; a 1 s stall hits the first spurt.
    const arrivals: Arrival[] = [];
    let pts = 0;
    let at = 0;
    let last = 0;
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < 40; i++) {
        // Frames 10.. of the first spurt are held for up to 1 s, then arrive at once.
        last = Math.max(last, at + (s === 0 && i === 10 ? 1000 : 0));
        arrivals.push({ at: last, pts, level: 0.5 });
        pts += FRAME;
        at += 20;
      }
      last = Math.max(last, at);
      arrivals.push({ at: last, pts, end: true });
      pts += 15 * FRAME; // 300 ms pause
      at += 300;
    }
    const { out, jb } = run(arrivals, 12000);
    // Delay of the last spurt's start: when it plays versus when it arrived.
    const lastArrival = arrivals.filter((x) => !x.end).at(-40)!.at / 1000;
    expect(jb.stats.underruns).toBe(1);
    let lastStart = out.length - 1;
    while (lastStart > 0 && Math.abs(out[lastStart]) < 1e-3) lastStart--;
    while (lastStart > 0 && Math.abs(out[lastStart - 1]) >= 1e-3) lastStart--;
    const delay = lastStart / RATE - lastArrival;
    // The 1 s backlog is gone; what remains is the raised target (a stall
    // keeps the reserve up for 30 s), capped at 500 ms.
    expect(jb.stats.pauseShift / RATE).toBeLessThan(-0.4);
    expect(delay).toBeLessThan(0.55);
  });

  it("falls silent within a few milliseconds of a flush and plays the next spurt normally", () => {
    const flushAt = 1000;
    const { out } = run(speech(200, () => 0), 4500, [{ at: flushAt, act: (jb) => jb.flush() }]);
    const cut = Math.round((flushAt / 1000) * RATE);
    const silentFrom = cut + out.subarray(cut).findIndex((x) => Math.abs(x) < 1e-3);
    expect((silentFrom - cut) / RATE).toBeLessThan(0.01);
    // The sender keeps talking after the flush; that audio is played again.
    expect(out.subarray(Math.round(1.4 * RATE)).some((x) => Math.abs(x) > 0.1)).toBe(true);
  });

  it("without media positions keeps the Realtime route's fixed 140 ms start and back-to-back order", () => {
    // Realtime sends faster than real time: 2 s of audio in 200 ms.
    const fast = Array.from({ length: 100 }, (_, i) => ({ at: i * 2, pts: null, level: 0.5 }));
    const { out, jb } = run(fast, 3000);
    expect(firstSound(out) / RATE).toBeCloseTo(0.14, 2);
    expect(holes(out)).toEqual([]);
    expect(jb.stats.trimmed).toBe(0);
  });

  it("drops only a backlog beyond 1.5 s above target", () => {
    const burst = Array.from({ length: 150 }, (_, i) => ({ at: 0, pts: i * FRAME, level: 0.5 }));
    const { jb } = run(burst, 500);
    expect(jb.stats.trimmed / RATE).toBeGreaterThan(1);
    expect(jb.buffered() / RATE).toBeLessThan(0.5);
  });
});
