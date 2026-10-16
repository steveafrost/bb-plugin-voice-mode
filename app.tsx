// Voice Mode frontend: a thread-header mic button that runs a full-duplex
// voice session with the thread's agent. Mic PCM streams to the plugin backend
// over a WebSocket; model audio streams back and plays gaplessly. When the
// proxy reports INTERRUPTION (the user started talking), queued playback stops
// at once.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { BrowserToServer, ServerToBrowser } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const PLUGIN_ID = "voice-mode";

type Phase = "off" | "connecting" | "listening" | "speaking" | "error";

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

/** Plays 24 kHz PCM chunks back to back and can drop everything queued. */
class Player {
  private readonly ctx: AudioContext;
  private playhead = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  onIdle: (() => void) | null = null;

  constructor(sampleRate: number) {
    this.ctx = new AudioContext({ sampleRate });
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  enqueue(base64: string) {
    const samples = float32FromBase64Pcm16(base64);
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, this.ctx.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + 0.02, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onIdle?.();
    };
  }

  interrupt() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
    this.playhead = 0;
    this.onIdle?.();
  }

  async close() {
    this.interrupt();
    await this.ctx.close().catch(() => undefined);
  }
}

/** Captures the mic at the session's input rate as PCM16 chunks. */
async function startMic(sampleRate: number, onChunk: (base64: string) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor avoids loading a worklet module under bb's CSP; 1024
  // frames at 16 kHz is a 64 ms chunk.
  const processor = ctx.createScriptProcessor(1024, 1, 1);
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    onChunk(base64FromInt16(pcm));
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

function sessionUrl(threadId: string): string {
  const url = new URL(`/api/v1/plugins/${PLUGIN_ID}/http/session`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("threadId", threadId);
  return url.toString();
}

function useVoiceSession(threadId: string) {
  const [phase, setPhase] = useState<Phase>("off");
  const [caption, setCaption] = useState<string>("");
  const [agentStatus, setAgentStatus] = useState<string | null>(null);
  const teardown = useRef<(() => Promise<void>) | null>(null);

  const stop = useCallback(async () => {
    const run = teardown.current;
    teardown.current = null;
    await run?.();
  }, []);

  const start = useCallback(async () => {
    if (teardown.current) return;
    setPhase("connecting");
    setCaption("");
    const ws = new WebSocket(sessionUrl(threadId));
    let player: Player | null = null;
    let stopMic: (() => Promise<void>) | null = null;
    let ended = false;
    const send = (message: BrowserToServer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const cleanup = async (nextPhase: Phase = "off") => {
      if (ended) return;
      ended = true;
      teardown.current = null;
      send({ type: "END" });
      ws.close();
      await stopMic?.();
      await player?.close();
      setPhase(nextPhase);
    };
    teardown.current = () => cleanup("off");

    ws.onmessage = async (event) => {
      const message = JSON.parse(String(event.data)) as ServerToBrowser;
      switch (message.type) {
        case "READY":
          player = new Player(message.outputHz);
          player.onIdle = () => setPhase((p) => (p === "speaking" ? "listening" : p));
          try {
            stopMic = await startMic(message.inputHz, (base64Data) => send({ type: "AUDIO", base64Data }));
            setPhase("listening");
          } catch (error) {
            setCaption(`Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`);
            await cleanup("error");
          }
          break;
        case "AUDIO":
          player?.enqueue(message.base64Data);
          setPhase("speaking");
          break;
        case "INTERRUPTION":
          player?.interrupt();
          setPhase("listening");
          break;
        case "TRANSCRIPT":
          setCaption(`${message.role === "user" ? "You" : "Voice"}: ${message.text}`);
          break;
        case "TOOL":
          setCaption(
            message.name === "send_to_agent" ? `Sent to agent: ${message.detail}` : message.name === "stop_agent" ? "Stopped the agent" : `Agent: ${message.detail}`,
          );
          break;
        case "AGENT_STATUS":
          setAgentStatus(message.status);
          break;
        case "ERROR":
          setCaption(message.message);
          await cleanup("error");
          break;
        case "ENDED":
          await cleanup("off");
          break;
      }
    };
    ws.onerror = () => {
      setCaption("Could not reach the Voice Mode backend");
      void cleanup("error");
    };
    ws.onclose = () => void cleanup("off");
  }, [threadId]);

  useEffect(() => () => void stop(), [stop]);

  return { phase, caption, agentStatus, start, stop };
}

const LABELS: Record<Phase, string> = {
  off: "Start voice mode",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Speaking",
  error: "Voice mode error",
};

function VoiceButton({ threadId, isCompactViewport }: { threadId: string; isCompactViewport: boolean }) {
  const { phase, caption, agentStatus, start, stop } = useVoiceSession(threadId);
  const live = phase === "connecting" || phase === "listening" || phase === "speaking";
  const label = live ? `Stop voice mode (${LABELS[phase].toLowerCase()})` : LABELS[phase];
  const tooltip = [label, agentStatus && live ? `Agent: ${agentStatus}` : "", caption].filter(Boolean).join("\n");

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        aria-label={label}
        aria-pressed={live}
        title={tooltip}
        onClick={() => void (live ? stop() : start())}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          live && "text-foreground",
          phase === "error" && "text-destructive",
        )}
      >
        <Icon
          name={phase === "connecting" ? "Loader2" : phase === "speaking" ? "AudioLines" : "Mic"}
          className={cn(
            "size-4",
            phase === "connecting" && "animate-spin",
            phase === "listening" && "animate-pulse text-red-500",
            phase === "speaking" && "text-sky-500",
          )}
        />
        {live && !isCompactViewport ? <span className="text-xs">{LABELS[phase]}</span> : null}
      </button>
      {live && caption && !isCompactViewport ? (
        <span className="max-w-64 truncate text-xs text-muted-foreground" aria-live="polite">
          {caption}
        </span>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "voice-mode",
    title: "Voice mode",
    component: ({ threadId, isCompactViewport }) => <VoiceButton threadId={threadId} isCompactViewport={isCompactViewport} />,
  });
});
