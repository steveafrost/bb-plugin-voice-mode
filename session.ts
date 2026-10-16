// One voice session per thread, held outside React so the composer pill and
// the mic's hold gesture share it and it survives composer re-renders. Only one
// session runs at a time: starting a second ends the first.
import type { BrowserToServer, ServerToBrowser } from "./server";
import { BARGE_IN_CHUNKS, BARGE_IN_RMS, Player, startMic } from "./audio";

const PLUGIN_ID = "voice-mode";
/** Composer remounts (layout switch, pane moves) shouldn't end a live session. */
const UNMOUNT_GRACE_MS = 1500;

export type Phase = "off" | "connecting" | "listening" | "speaking" | "error";

export interface VoiceState {
  phase: Phase;
  muted: boolean;
  caption: string;
  agentStatus: string | null;
}

const OFF: VoiceState = { phase: "off", muted: false, caption: "", agentStatus: null };

export const isLive = (phase: Phase) => phase === "connecting" || phase === "listening" || phase === "speaking";

function sessionUrl(threadId: string): string {
  const url = new URL(`/api/v1/plugins/${PLUGIN_ID}/http/session`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("threadId", threadId);
  return url.toString();
}

export class VoiceSession {
  state: VoiceState = OFF;
  private readonly listeners = new Set<() => void>();
  private teardown: (() => Promise<void>) | null = null;
  private player: Player | null = null;
  private micLevel = 0;
  private mounts = 0;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly threadId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  getState = () => this.state;

  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Audible level, 0..1: the model's voice while speaking, else the mic. */
  level(): number {
    if (this.state.phase === "speaking") return this.player?.level() ?? 0;
    return this.state.muted ? 0 : this.micLevel;
  }

  setMuted(muted: boolean) {
    this.set({ muted });
  }

  /** Called by each mounted composer; the last unmount ends the session. */
  retain() {
    this.mounts++;
    clearTimeout(this.graceTimer);
    return () => {
      this.mounts--;
      if (this.mounts > 0) return;
      this.graceTimer = setTimeout(() => {
        if (this.mounts === 0) void this.stop();
      }, UNMOUNT_GRACE_MS);
    };
  }

  dismissError() {
    if (this.state.phase === "error") this.set({ phase: "off", caption: "" });
  }

  async stop() {
    const run = this.teardown;
    this.teardown = null;
    await run?.();
  }

  async start() {
    if (this.teardown) return;
    for (const other of sessions.values()) if (other !== this) await other.stop();
    this.set({ phase: "connecting", caption: "", agentStatus: null, muted: false });
    const ws = new WebSocket(sessionUrl(this.threadId));
    let stopMic: (() => Promise<void>) | null = null;
    let ended = false;
    const send = (message: BrowserToServer) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const cleanup = async (next: Phase = "off") => {
      if (ended) return;
      ended = true;
      this.teardown = null;
      send({ type: "END" });
      ws.close();
      await stopMic?.();
      await this.player?.close();
      this.player = null;
      this.micLevel = 0;
      this.set({ phase: next, muted: false, ...(next === "off" ? { caption: "" } : {}) });
    };
    this.teardown = () => cleanup("off");

    ws.onmessage = async (event) => {
      const message = JSON.parse(String(event.data)) as ServerToBrowser;
      switch (message.type) {
        case "READY": {
          const player = new Player(message.outputHz);
          this.player = player;
          player.onIdle = () => {
            if (this.state.phase === "speaking") this.set({ phase: "listening" });
          };
          try {
            let loudChunks = 0;
            stopMic = await startMic(message.inputHz, () => this.state.muted, (base64Data, rms) => {
              send({ type: "AUDIO", base64Data });
              this.micLevel = rms;
              loudChunks = rms > BARGE_IN_RMS ? loudChunks + 1 : 0;
              if (loudChunks >= BARGE_IN_CHUNKS && player.playing) {
                player.interrupt();
                this.set({ phase: "listening" });
              }
            });
            // The user may have ended the session while the permission prompt was open.
            if (ended) {
              await stopMic();
              break;
            }
            this.set({ phase: "listening" });
          } catch (error) {
            this.set({ caption: `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}` });
            await cleanup("error");
          }
          break;
        }
        case "AUDIO":
          this.player?.enqueue(message.base64Data);
          if (this.state.phase !== "speaking") this.set({ phase: "speaking" });
          break;
        case "INTERRUPTION":
          this.player?.interrupt();
          this.set({ phase: "listening" });
          break;
        case "TRANSCRIPT":
          this.set({ caption: `${message.role === "user" ? "You" : "Voice"}: ${message.text}` });
          break;
        case "TOOL":
          this.set({
            caption:
              message.name === "send_to_agent"
                ? `Sent to agent: ${message.detail}`
                : message.name === "stop_agent"
                  ? "Stopped the agent"
                  : `Agent: ${message.detail}`,
          });
          break;
        case "AGENT_STATUS":
          this.set({ agentStatus: message.status });
          break;
        case "ERROR":
          this.set({ caption: message.message });
          await cleanup("error");
          break;
        case "ENDED":
          await cleanup("off");
          break;
      }
    };
    ws.onerror = () => {
      this.set({ caption: "Could not reach the Voice Mode backend" });
      void cleanup("error");
    };
    ws.onclose = () => void cleanup("off");
  }
}

const sessions = new Map<string, VoiceSession>();

export function sessionFor(threadId: string): VoiceSession {
  let session = sessions.get(threadId);
  if (!session) {
    session = new VoiceSession(threadId);
    sessions.set(threadId, session);
  }
  return session;
}

export async function stopAllSessions() {
  await Promise.all([...sessions.values()].map((session) => session.stop()));
}
