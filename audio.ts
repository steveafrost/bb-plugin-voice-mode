// Audio plumbing for Voice Mode: PCM16 <-> base64, jitter-buffered playback
// with instant interrupt, and mic capture at the session's input rate.
//
// Both directions run on the audio thread (AudioWorklet) so a busy page does
// not punch holes into either stream. If a worklet module cannot be loaded
// (for example under a strict CSP), a single ScriptProcessor drives the same
// jitter buffer instead.
import { JitterBuffer } from "./jitter";

function base64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function float32FromBase64Pcm16(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 0x8000;
  return out;
}

// Output quieter than this (about -48 dBFS) for AUDIBLE_HOLD seconds counts
// as the assistant having stopped speaking.
const AUDIBLE_RMS = 0.004;
const AUDIBLE_HOLD = 0.35;
const MIC_CHUNK = 1024;

/** Tracks whether playback is audible, with a hold so word gaps don't flicker. */
// Self-contained: its source is also loaded into the worklet.
export class Audibility {
  audible = false;
  quiet = 0;
  hold: number;
  threshold: number;
  constructor(holdSamples: number, threshold: number) {
    this.hold = holdSamples;
    this.threshold = threshold;
  }
  /** Returns true when the state changed. */
  update(level: number, samples: number): boolean {
    if (level > this.threshold) {
      this.quiet = 0;
      if (this.audible) return false;
      this.audible = true;
      return true;
    }
    this.quiet += samples;
    if (!this.audible || this.quiet < this.hold) return false;
    this.audible = false;
    return true;
  }
}

// Loaded as a module into each AudioContext. JitterBuffer is self-contained.
export function workletSource() {
  return `const JitterBuffer = ${JitterBuffer.toString()};
const Audibility = ${Audibility.toString()};
class VoicePlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jb = new JitterBuffer(sampleRate);
    this.audibility = new Audibility(${AUDIBLE_HOLD} * sampleRate, ${AUDIBLE_RMS});
    this.sinceLevel = 0;
    this.closed = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === "pcm") this.jb.push(m.d, m.p, currentFrame);
      else if (m.t === "end") this.jb.end(m.p, currentFrame);
      else if (m.t === "flush") { this.jb.flush(); this.audibility.audible = false; this.audibility.quiet = 0; }
      else if (m.t === "stats") this.port.postMessage({ t: "stats", id: m.id, stats: { ...this.jb.stats, target: this.jb.target / sampleRate, buffered: this.jb.buffered() / sampleRate, state: this.jb.state } });
      else if (m.t === "close") this.closed = true;
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    this.jb.render(out[0], currentFrame);
    for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    const level = this.jb.level;
    if (this.audibility.update(level, out[0].length)) this.port.postMessage({ t: "audible", on: this.audibility.audible });
    this.sinceLevel += out[0].length;
    if (this.audibility.audible && this.sinceLevel >= sampleRate / 25) {
      this.sinceLevel = 0;
      this.port.postMessage({ t: "level", v: level });
    }
    return !this.closed;
  }
}
registerProcessor("bb-voice-player", VoicePlayer);
class VoiceMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${MIC_CHUNK});
    this.n = 0;
    this.closed = false;
    this.port.onmessage = (e) => { if (e.data.t === "close") this.closed = true; };
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      let i = 0;
      while (i < input.length) {
        const k = Math.min(input.length - i, this.buf.length - this.n);
        this.buf.set(input.subarray(i, i + k), this.n);
        this.n += k;
        i += k;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(${MIC_CHUNK});
          this.n = 0;
        }
      }
    }
    return !this.closed;
  }
}
registerProcessor("bb-voice-mic", VoiceMic);
`;
}

let moduleUrl: string | null = null;

/** Loads the worklet module; false when the page refuses it. */
async function loadWorklet(ctx: BaseAudioContext): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  try {
    moduleUrl ??= URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(moduleUrl);
    return true;
  } catch {
    return false;
  }
}

type Sink = { post(message: { t: string; d?: Float32Array; p?: number | null; id?: number }, transfer?: Transferable[]): void; close(): void };

/** Plays 24 kHz PCM through an adaptive jitter buffer and can drop everything queued. */
export class Player {
  private readonly ctx: AudioContext;
  private sink: Sink | null = null;
  private readonly early: { t: string; d?: Float32Array; p?: number | null }[] = [];
  private audibleNow = false;
  private lastLevel = 0;
  private statsId = 0;
  private readonly statsWaiters = new Map<number, (stats: Record<string, number>) => void>();
  /** Resolves once audio can flow; the mode says which engine is in use. */
  readonly ready: Promise<"worklet" | "script">;
  onIdle: (() => void) | null = null;
  onActive: (() => void) | null = null;

  constructor(sampleRate: number, context?: AudioContext) {
    this.ctx = context ?? new AudioContext({ sampleRate });
    this.ready = this.init();
  }

  private async init(): Promise<"worklet" | "script"> {
    const ctx = this.ctx;
    let mode: "worklet" | "script";
    if (await loadWorklet(ctx)) {
      const node = new AudioWorkletNode(ctx, "bb-voice-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => this.fromEngine(e.data);
      node.connect(ctx.destination);
      this.sink = {
        post: (m, transfer) => node.port.postMessage(m, transfer ?? []),
        close: () => { node.port.postMessage({ t: "close" }); node.disconnect(); },
      };
      mode = "worklet";
    } else {
      // Fallback: one ScriptProcessor on the main thread. 2048 frames
      // (85 ms at 24 kHz) rides out short main-thread stalls.
      const jb = new JitterBuffer(ctx.sampleRate);
      const audibility = new Audibility(AUDIBLE_HOLD * ctx.sampleRate, AUDIBLE_RMS);
      const now = () => Math.round(ctx.currentTime * ctx.sampleRate);
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        const out = event.outputBuffer.getChannelData(0);
        jb.render(out, now());
        this.lastLevel = jb.level;
        if (audibility.update(jb.level, out.length)) this.fromEngine({ t: "audible", on: audibility.audible });
      };
      processor.connect(ctx.destination);
      this.sink = {
        post: (m) => {
          if (m.t === "pcm") jb.push(m.d!, m.p ?? null, now());
          else if (m.t === "end") jb.end(m.p!, now());
          else if (m.t === "flush") { jb.flush(); audibility.audible = false; audibility.quiet = 0; }
          else if (m.t === "stats") this.fromEngine({ t: "stats", id: m.id, stats: { ...jb.stats, target: jb.target / ctx.sampleRate, buffered: jb.buffered() / ctx.sampleRate, state: jb.state } });
        },
        close: () => { processor.onaudioprocess = null; processor.disconnect(); },
      };
      mode = "script";
    }
    for (const m of this.early.splice(0)) this.sink.post(m, m.d ? [m.d.buffer] : []);
    return mode;
  }

  private fromEngine(m: { t: string; on?: boolean; v?: number; id?: number; stats?: Record<string, number> }) {
    if (m.t === "audible") {
      this.audibleNow = !!m.on;
      if (!m.on) this.lastLevel = 0;
      (m.on ? this.onActive : this.onIdle)?.();
    } else if (m.t === "level") this.lastLevel = m.v ?? 0;
    else if (m.t === "stats") {
      this.statsWaiters.get(m.id!)?.(m.stats!);
      this.statsWaiters.delete(m.id!);
    }
  }

  private post(m: { t: string; d?: Float32Array; p?: number | null }) {
    if (this.sink) this.sink.post(m, m.d ? [m.d.buffer] : []);
    else this.early.push(m);
  }

  /** RMS of what is audible right now, 0..1. */
  level(): number {
    return this.audibleNow ? this.lastLevel : 0;
  }

  /** Whether the assistant's voice is audible now. */
  get playing(): boolean {
    return this.audibleNow;
  }

  /**
   * Queues one chunk. `pts` is its position in the sender's media clock, in
   * samples; empty audio with a pts marks the start of a silent stretch.
   */
  enqueue(base64: string, pts?: number) {
    const p = typeof pts === "number" && Number.isFinite(pts) ? pts : null;
    if (!base64) {
      if (p !== null) this.post({ t: "end", p });
      return;
    }
    const samples = float32FromBase64Pcm16(base64);
    if (samples.length === 0) return;
    this.post({ t: "pcm", d: samples, p });
  }

  /** Stops playback within a few milliseconds and drops everything queued. */
  interrupt() {
    this.post({ t: "flush" });
    this.early.length = 0;
    if (this.audibleNow) this.fromEngine({ t: "audible", on: false });
  }

  /** Engine counters, for diagnostics and the measurement harness. */
  stats(): Promise<Record<string, number>> {
    const id = ++this.statsId;
    return new Promise((resolve) => {
      this.statsWaiters.set(id, resolve);
      this.post({ t: "stats", id } as { t: string });
    });
  }

  async close() {
    this.interrupt();
    this.sink?.close();
    await this.ctx.close().catch(() => undefined);
  }
}

// Local barge-in: the proxy can only interrupt audio it is still generating,
// and it sends audio faster than real time. If the user talks over audio we
// already buffered, cut playback here. 5 chunks (~213 ms at 24 kHz) above this
// RMS count as speech;
// echo cancellation keeps the model's own voice well below it.
export const BARGE_IN_RMS = 0.04;
export const BARGE_IN_CHUNKS = 5;

/** Captures the mic at the session's input rate as PCM16 chunks. */
// While muted the mic keeps running but sends digital silence, so the session
// stays open and the server VAD still sees the end of any cut-off utterance.
export async function startMic(sampleRate: number, isMuted: () => boolean, onChunk: (base64: string, rms: number) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor avoids loading a worklet module under bb's CSP; 1024
  // frames at 24 kHz is a ~43 ms chunk.
  const processor = ctx.createScriptProcessor(1024, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    if (isMuted()) {
      onChunk(base64FromInt16(pcm), 0);
      return;
    }
    let energy = 0;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      energy += s * s;
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    onChunk(base64FromInt16(pcm), Math.sqrt(energy / input.length));
  };
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  return async () => {
    processor.onaudioprocess = null;
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close().catch(() => undefined);
  };
}

