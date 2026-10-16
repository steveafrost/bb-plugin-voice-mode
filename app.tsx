// Voice Mode frontend. Voice mode lives on bb's own composer mic:
//
// - Click the mic: bb's dictation, unchanged.
// - Press and hold the mic: the glyph morphs into a waveform and, once held,
//   starts a full-duplex voice session with the thread's agent.
// - While live, the mic is replaced by a Codex-style pill: a level-reactive
//   waveform, status, a mute toggle, and an end button.
//
// bb exposes no SDK hook on its mic, so a content script handles the hold
// gesture on the DOM button, and a composer action portals the pill beside it.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useComposer } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import { isLive, sessionFor, stopAllSessions, type Phase, type VoiceSession } from "./session";
import { mountMicHold, MIC_SELECTOR, THREAD_ATTR, LIVE_ATTR } from "./mic-hold";
import "./app.css";

const LABELS: Record<Phase, string> = {
  off: "Voice mode",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Speaking",
  error: "Voice mode error",
};
const ERROR_DISMISS_MS = 6000;

function useVoiceState(session: VoiceSession) {
  return useSyncExternalStore(session.subscribe, session.getState);
}

// Codex-style waveform: seven rounded bars, tallest in the middle, driven by
// the live audio level (mic while listening, the model's voice while speaking).
const PROFILE = [0.35, 0.6, 0.85, 1, 0.85, 0.6, 0.35];
const BAR_W = 2.5;
const GAP = 1.5;
const H = 16;
const MIN_H = 2.5;

function LevelWave({ session, phase, muted }: { session: VoiceSession; phase: Phase; muted: boolean }) {
  const bars = useRef<(SVGRectElement | null)[]>([]);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const current = PROFILE.map(() => MIN_H);
    let frame = 0;
    const tick = (now: number) => {
      const level = session.level();
      const gain = phase === "speaking" ? 5 : 7;
      PROFILE.forEach((weight, i) => {
        let amount: number;
        if (muted) amount = 0;
        else if (phase === "connecting") amount = reduce ? 0.4 : 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(now / 220 - i * 0.7));
        else if (reduce) amount = 0.5;
        else {
          const wobble = 0.12 + 0.06 * Math.sin(now / 160 + i * 1.3);
          amount = Math.min(1, wobble + level * gain * (0.75 + 0.25 * Math.sin(now / 90 + i * 2.1)));
        }
        const target = MIN_H + (H - MIN_H) * weight * amount;
        current[i] += (target - current[i]) * 0.35;
        const rect = bars.current[i];
        if (rect) {
          rect.setAttribute("height", current[i].toFixed(2));
          rect.setAttribute("y", ((H - current[i]) / 2).toFixed(2));
        }
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [session, phase, muted]);

  const width = PROFILE.length * BAR_W + (PROFILE.length - 1) * GAP;
  return (
    <svg viewBox={`0 0 ${width} ${H}`} width={width} height={H} fill="currentColor" aria-hidden className="shrink-0">
      {PROFILE.map((_, i) => (
        <rect
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          x={i * (BAR_W + GAP)}
          y={(H - MIN_H) / 2}
          width={BAR_W}
          height={MIN_H}
          rx={BAR_W / 2}
        />
      ))}
    </svg>
  );
}

// Lucide mic / mic-off / x glyphs, inlined because bb's icon set lacks MicOff.
function Glyph({ name }: { name: "mic" | "mic-off" | "x" | "alert" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-4"
    >
      {name === "mic-off" ? (
        <>
          <line x1="2" x2="22" y1="2" y2="22" />
          <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
          <path d="M5 10v2a7 7 0 0 0 12 5" />
          <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
          <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </>
      ) : name === "mic" ? (
        <>
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </>
      ) : name === "x" ? (
        <>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </>
      ) : (
        <>
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </>
      )}
    </svg>
  );
}

const PILL_BUTTON =
  "inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function VoicePill({ session }: { session: VoiceSession }) {
  const { phase, muted, caption, agentStatus } = useVoiceState(session);

  useEffect(() => {
    if (phase !== "error") return;
    const timer = setTimeout(() => session.dismissError(), ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [phase, session]);

  if (phase === "off") return null;
  const micActive = phase === "listening" || phase === "speaking";
  const status = phase === "error" ? "Voice error" : muted && micActive ? "Muted" : LABELS[phase];
  const detail = [agentStatus ? `Agent: ${agentStatus}` : "", caption].filter(Boolean).join("\n");

  return (
    <div
      data-voice-mode-pill=""
      data-phase={phase}
      data-muted={muted}
      className={cn(
        "voice-mode-pill inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-state-hover pl-2.5 pr-1 text-foreground",
        phase === "speaking" && "text-sky-500",
        phase === "error" && "text-destructive",
        muted && micActive && "text-muted-foreground",
      )}
    >
      <span role="status" aria-live="polite" title={detail || undefined} className="inline-flex items-center gap-2 pr-1">
        {phase === "error" ? <Glyph name="alert" /> : <LevelWave session={session} phase={phase} muted={muted && micActive} />}
        <span className="text-xs font-medium text-foreground/80">{status}</span>
      </span>
      {micActive ? (
        <button
          type="button"
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          title={muted ? "Unmute microphone" : "Mute microphone (voice mode stays on)"}
          onClick={() => session.setMuted(!muted)}
          className={cn(PILL_BUTTON, muted && "bg-background text-red-500 hover:text-red-500")}
        >
          <Glyph name={muted ? "mic-off" : "mic"} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={phase === "error" ? "Dismiss voice mode error" : "End voice mode"}
        title={phase === "error" ? caption || "Dismiss" : "End voice mode"}
        onClick={() => void (phase === "error" ? session.dismissError() : session.stop())}
        className={PILL_BUTTON}
      >
        <Glyph name="x" />
      </button>
    </div>
  );
}

/**
 * Mounted once per thread composer. Tags the composer so the mic's hold
 * gesture knows its thread, keeps a portal host beside the mic, and renders
 * the pill there (inline here when the mic isn't rendered).
 */
function ComposerVoice() {
  const composer = useComposer();
  const threadId = composer.scope.kind === "thread" ? composer.scope.threadId : null;
  return threadId ? <ThreadComposerVoice threadId={threadId} /> : null;
}

function ThreadComposerVoice({ threadId }: { threadId: string }) {
  const session = sessionFor(threadId);
  const { phase } = useVoiceState(session);
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const showing = phase !== "off";

  useEffect(() => session.retain(), [session]);

  useEffect(() => {
    const start = anchor.current;
    if (!start) return;
    // The mic can render after this action does, so key off the composer form
    // and look the mic up on every change.
    const composerRoot = start.closest("form");
    if (!composerRoot) return;
    composerRoot.setAttribute(THREAD_ATTR, threadId);
    const portal = document.createElement("span");
    portal.className = "voice-mode-host";
    let frame = 0;
    const place = () => {
      frame = 0;
      const wrapper = composerRoot.querySelector(MIC_SELECTOR)?.parentElement;
      if (wrapper && portal.nextSibling !== wrapper) wrapper.before(portal);
      setHost(portal.isConnected ? portal : null);
    };
    place();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(place);
    });
    observer.observe(composerRoot, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      portal.remove();
      composerRoot.removeAttribute(THREAD_ATTR);
      composerRoot.removeAttribute(LIVE_ATTR);
      setHost(null);
    };
  }, [threadId]);

  // Hide bb's mic while the pill stands in for it.
  useEffect(() => {
    const root = host?.closest(`[${THREAD_ATTR}]`);
    if (!root) return;
    if (showing) root.setAttribute(LIVE_ATTR, "");
    else root.removeAttribute(LIVE_ATTR);
  }, [host, showing]);

  const pill = <VoicePill session={session} />;
  return (
    <>
      <span ref={anchor} hidden />
      {host ? createPortal(pill, host) : isLive(phase) || phase === "error" ? pill : null}
    </>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "voice-mode",
    scopes: ["thread"],
    actions: [{ id: "voice-mode", component: ComposerVoice }],
  });

  app.composer.experimental_registerCommand({
    id: "toggle-voice-mode",
    title: "Toggle voice mode",
    run({ composer }) {
      if (composer.scope.kind !== "thread") return;
      const session = sessionFor(composer.scope.threadId);
      void (isLive(session.state.phase) ? session.stop() : session.start());
    },
  });

  app.contentScripts.register({
    id: "mic-hold",
    mount({ signal }) {
      const unmount = mountMicHold(signal);
      return () => {
        unmount();
        void stopAllSessions();
      };
    },
  });
});
