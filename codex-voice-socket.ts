// Adapts the private media pipe to the Live session used by both voice routes.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export class CodexVoiceSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | Blob }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  private readonly child;
  private killTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    const dir = join(homedir(), ".local/share/bb-voice-mode/codex-live");
    this.child = spawn(join(dir, "venv/bin/python"), ["-I", join(dir, "codex_voice.py")], {
      stdio: ["pipe", "pipe", "ignore"],
      // The helper and its Codex subprocess belong to this call only.
      detached: true,
    });
    createInterface({ input: this.child.stdout }).on("line", data => this.onmessage?.({ data }));
    this.child.once("spawn", () => {
      if (this.readyState !== WebSocket.CONNECTING) return;
      this.readyState = WebSocket.OPEN;
      this.onopen?.();
    });
    this.child.stdin.on("error", () => { if (this.readyState === WebSocket.OPEN) this.onerror?.(); });
    this.child.once("error", () => this.onerror?.());
    this.child.once("close", () => {
      clearTimeout(this.killTimer);
      const requested = this.readyState === WebSocket.CLOSING;
      this.readyState = WebSocket.CLOSED;
      this.onclose?.({code: requested ? 1000 : 1006, reason: requested ? "" : "Codex Live disconnected"});
    });
  }

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) return;
    if (this.child.stdin.writableLength > 512 * 1024) { this.onerror?.(); return; }
    this.child.stdin.write(data + "\n");
  }

  close(_code?: number) {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (this.child.pid) {
        try { process.kill(-this.child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }, 3500);
    this.killTimer.unref();
  }
}
