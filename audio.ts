// Audio plumbing for Voice Mode: PCM16 <-> base64, jitter-buffered playback
// with instant interrupt, and mic capture at the session's input rate.
//
// Both directions run on the audio thread (AudioWorklet) so a busy page does
// not punch holes into either stream. Under a strict CSP, ScriptProcessor
// nodes fall back to capture and playback on the main thread.
import { JitterBuffer } from "./jitter";

function base64FromInt16(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function float32FromBase64Pcm16(base64: string): Float32Array<ArrayBuffer> {
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
const CAPTURE_FRAMES = 1024;

/** Tracks whether playback is audible, with a hold so word gaps don't flicker. */
// Self-contained: its source is also loaded into the worklet.
export class Audibility {
  audible = false;
  private quiet = 0;
  private readonly hold: number;
  private readonly threshold: number;
  constructor(holdSamples: number, threshold: number) {
    this.hold = holdSamples;
    this.threshold = threshold;
  }
  reset() {
    this.audible = false;
    this.quiet = 0;
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

// Both classes must stringify without dependencies from the bundled module.
export function workletSource(): string {
  return `const JitterBuffer = ${JitterBuffer.toString()};
const Audibility = ${Audibility.toString()};
class VoicePlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.jb = new JitterBuffer(sampleRate);
    this.audibility = new Audibility(${AUDIBLE_HOLD} * sampleRate, ${AUDIBLE_RMS});
    this.sinceLevel = 0;
    this.generation = 0;
    this.port.onmessage = ({ data: m }) => {
      if (m.t === "pcm") this.jb.push(m.d, m.p, currentFrame);
      else if (m.t === "end") this.jb.end(m.p, currentFrame);
      else if (m.t === "flush") {
        this.generation = m.generation;
        this.jb.flush();
        this.audibility.reset();
        this.sinceLevel = 0;
      } else if (m.t === "stats") {
        this.port.postMessage({ t: "stats", id: m.id, stats: this.jb.snapshot() });
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    this.jb.render(out, currentFrame);
    const level = this.jb.level;
    const on = this.audibility.audible;
    if (this.audibility.update(level, out.length)) {
      this.port.postMessage({ t: "audible", on: this.audibility.audible, generation: this.generation, level });
      this.sinceLevel = 0;
    } else if (on && (this.sinceLevel += out.length) >= sampleRate / 25) {
      this.sinceLevel = 0;
      this.port.postMessage({ t: "level", level, generation: this.generation });
    }
    return true;
  }
}
registerProcessor("bb-voice-player", VoicePlayer);
${CAPTURE_WORKLET}`;
}

async function createWorkletNode(
  ctx: AudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet) return null;
  const url = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
    return new AudioWorkletNode(ctx, name, options);
  } catch {
    // bb's CSP can refuse a worklet module; use the main-thread processor.
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

type EngineInput =
  | { t: "pcm"; d: Float32Array<ArrayBuffer>; p: number | null }
  | { t: "end"; p: number }
  | { t: "flush"; generation: number }
  | { t: "stats"; id: number };
type PlaybackStats = ReturnType<JitterBuffer["snapshot"]>;
type EngineOutput =
  | { t: "audible"; on: boolean; generation: number; level: number }
  | { t: "level"; generation: number; level: number }
  | { t: "stats"; id: number; stats: PlaybackStats };
type Sink = { post(message: EngineInput): void; close(): void };

/** Plays PCM through an adaptive jitter buffer and can drop everything queued. */
export class Player {
  private readonly ctx: AudioContext;
  private sink: Sink | null = null;
  private readonly early: EngineInput[] = [];
  private audibleNow = false;
  private lastLevel = 0;
  private generation = 0;
  private closed = false;
  private statsId = 0;
  private readonly statsWaiters = new Map<number, { resolve(stats: PlaybackStats): void; reject(error: Error): void }>();
  readonly ready: Promise<"worklet" | "script" | "closed">;
  onIdle: (() => void) | null = null;
  onActive: (() => void) | null = null;

  constructor(sampleRate: number) {
    this.ctx = new AudioContext({ sampleRate });
    this.ready = this.init();
  }

  private async init(): Promise<"worklet" | "script" | "closed"> {
    const node = await createWorkletNode(this.ctx, "bb-voice-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    if (this.closed) {
      node?.port.close();
      return "closed";
    }
    if (node) {
      node.port.onmessage = (event: MessageEvent<EngineOutput>) => this.fromEngine(event.data);
      node.connect(this.ctx.destination);
      this.sink = {
        post: (m) => node.port.postMessage(m, m.t === "pcm" ? [m.d.buffer] : []),
        close: () => {
          node.port.onmessage = null;
          node.port.close();
          node.disconnect();
        },
      };
    } else {
      this.sink = this.createScriptSink();
    }
    for (const message of this.early.splice(0)) this.sink.post(message);
    return node ? "worklet" : "script";
  }

  private createScriptSink(): Sink {
    const ctx = this.ctx;
    const jb = new JitterBuffer(ctx.sampleRate);
    const audibility = new Audibility(AUDIBLE_HOLD * ctx.sampleRate, AUDIBLE_RMS);
    const now = () => Math.round(ctx.currentTime * ctx.sampleRate);
    // 2048 frames (85 ms at 24 kHz) ride out short main-thread stalls.
    /* oxlint-disable typescript/no-deprecated */
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0);
      jb.render(out, now());
      this.lastLevel = jb.level;
      if (audibility.update(jb.level, out.length)) this.setAudible(audibility.audible);
    };
    processor.connect(ctx.destination);
    return {
      post: (m) => {
        switch (m.t) {
          case "pcm": jb.push(m.d, m.p, now()); break;
          case "end": jb.end(m.p, now()); break;
          case "flush":
            jb.flush();
            audibility.reset();
            break;
          case "stats": this.fromEngine({ t: "stats", id: m.id, stats: jb.snapshot() }); break;
        }
      },
      close: () => {
        processor.onaudioprocess = null;
        processor.disconnect();
      },
    };
    /* oxlint-enable typescript/no-deprecated */
  }

  private fromEngine(m: EngineOutput) {
    if (this.closed) return;
    if (m.t === "stats") {
      this.statsWaiters.get(m.id)?.resolve(m.stats);
      this.statsWaiters.delete(m.id);
      return;
    }
    // The audio thread may have posted an event just before we interrupted it.
    if (m.generation !== this.generation) return;
    this.lastLevel = m.level;
    if (m.t === "audible") this.setAudible(m.on);
  }

  private setAudible(on: boolean) {
    if (on === this.audibleNow) return;
    this.audibleNow = on;
    (on ? this.onActive : this.onIdle)?.();
  }

  private post(m: EngineInput) {
    if (this.closed) return;
    if (this.sink) this.sink.post(m);
    else this.early.push(m);
  }

  /** RMS of what is audible right now, 0..1. */
  level(): number {
    return this.audibleNow ? this.lastLevel : 0;
  }

  get playing(): boolean {
    return this.audibleNow;
  }

  /**
   * Queues one chunk. `pts` is its position in the sender's media clock, in
   * samples; empty audio with a pts marks the start of a silent stretch.
   */
  enqueue(base64: string, pts?: number) {
    const p = typeof pts === "number" && Number.isSafeInteger(pts) && pts >= 0 ? pts : null;
    if (!base64) {
      if (p !== null) this.post({ t: "end", p });
      return;
    }
    const d = float32FromBase64Pcm16(base64);
    if (d.length) this.post({ t: "pcm", d, p });
  }

  /** Drops queued audio, keeping only a short anti-click fade on the next render. */
  interrupt() {
    this.early.length = 0;
    this.post({ t: "flush", generation: ++this.generation });
    this.lastLevel = 0;
    this.setAudible(false);
  }

  /** Engine counters, for diagnostics and the measurement harness. */
  async stats(): Promise<PlaybackStats> {
    await this.ready;
    if (this.closed) throw new Error("Player is closed");
    const id = ++this.statsId;
    return new Promise((resolve, reject) => {
      this.statsWaiters.set(id, { resolve, reject });
      this.post({ t: "stats", id });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.early.length = 0;
    this.setAudible(false);
    this.sink?.close();
    this.sink = null;
    for (const { reject } of this.statsWaiters.values()) reject(new Error("Player is closed"));
    this.statsWaiters.clear();
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

const CAPTURE_WORKLET = `
class MicCapture extends AudioWorkletProcessor {
  buffer = new Float32Array(${CAPTURE_FRAMES});
  filled = 0;
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer);
        this.buffer = new Float32Array(${CAPTURE_FRAMES});
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("mic-capture", MicCapture);
`;

async function createCaptureNode(
  ctx: AudioContext,
  onFrame: (input: Float32Array) => void,
): Promise<AudioNode & { stop(): void }> {
  const node = await createWorkletNode(ctx, "mic-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  if (node) {
    node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
    return Object.assign(node, {
      stop() {
        node.port.onmessage = null;
        node.port.close();
      },
    });
  }
  /* oxlint-disable typescript/no-deprecated */
  const processor = ctx.createScriptProcessor(CAPTURE_FRAMES, 1, 1);
  processor.onaudioprocess = (event) => onFrame(event.inputBuffer.getChannelData(0));
  return Object.assign(processor, {
    stop() {
      processor.onaudioprocess = null;
    },
  });
  /* oxlint-enable typescript/no-deprecated */
}

/** Captures the mic at the session's input rate as PCM16 chunks. */
// While muted the mic keeps running but sends digital silence, so the session
// stays open and the server VAD still sees the end of any cut-off utterance.
export async function startMic(sampleRate: number, isMuted: () => boolean, onChunk: (base64: string, rms: number) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  const processor = await createCaptureNode(ctx, (input) => {
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
  });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  return async () => {
    processor.stop();
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close().catch(() => undefined);
  };
}

