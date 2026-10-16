// Voice Mode frontend, modeled on Codex: when the thread composer is empty the
// send button becomes a waveform button ("Start new voice chat"). Typing brings
// the send arrow back; once the message is sent and the box is empty again, the
// waveform returns. While live, a pill (level waveform, status, mute, end)
// stands in for bb's mic, and the send button reappears only if you type.
//
// bb has no SDK hook on its send button, so a composer action portals our UI
// beside it and flags the composer form so app.css can hide bb's controls.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useComposer } from "@get-bb/plugin-sdk/app";
import { isLive, sessionFor, stopAllSessions, type Phase, type VoiceSession } from "./session";
import "./app.css";

const LABELS: Record<Phase, string> = {
  off: "Voice mode",
  connecting: "Connecting…",
  listening: "Listening",
  speaking: "Speaking",
  error: "Voice mode error",
};
const ERROR_DISMISS_MS = 6000;

const cn = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(" ");

const SEND_SELECTOR = "[data-promptbox-send-menu]";
/** Set on the composer form while the waveform button replaces bb's send button. */
const VOICE_SEND_ATTR = "data-voice-mode-send";
/** Set on the composer form while the voice pill replaces bb's mic. */
const LIVE_ATTR = "data-voice-mode-live";

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
  "inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const PILL_BUTTON_IDLE = `${PILL_BUTTON} text-muted-foreground hover:text-foreground`;

/** How long the pill takes to slide open from the waveform button. */
const EXPAND_MS = 220;

/**
 * Where the pill slides open from: the box the mic and waveform took up when
 * you clicked start, keyed by session. Read once, by the pill that replaces them.
 */
const expandFrom = new WeakMap<VoiceSession, { width: number; background: string }>();

/**
 * Where the pill slides closed to: the same start box (mic plus waveform) and
 * the mic alone, for when you typed during the session and send is back. Kept
 * for the session's lifetime; the fallbacks are bb's default sizes.
 */
const restBox = new WeakMap<VoiceSession, { both: number; mic: number; background: string }>();
const REST_FALLBACK = { both: 96, mic: 32, background: "transparent" };

function rememberExpandFrom(session: VoiceSession, button: HTMLElement) {
  const right = button.getBoundingClientRect().right;
  // The mic sits left of the waveform and goes away with it, so start from its
  // left edge too; then nothing else in the composer row moves.
  const mic = button.closest("form")?.querySelector<HTMLElement>('button[aria-label="Start voice input"]');
  const left = mic?.getBoundingClientRect().width ? mic.getBoundingClientRect().left : button.getBoundingClientRect().left;
  const background = getComputedStyle(button).backgroundColor;
  expandFrom.set(session, { width: right - left, background });
  restBox.set(session, { both: right - left, mic: mic?.getBoundingClientRect().width || REST_FALLBACK.mic, background });
}

/**
 * The reverse of opening: shrink the pill rightward (right edge fixed) into the
 * box the mic and waveform (or just the mic, if send is showing) will take,
 * then hand over to them.
 */
function useSlideClosed(
  ref: React.RefObject<HTMLElement | null>,
  session: VoiceSession,
  closing: boolean,
  toStart: boolean,
  onClosed: () => void,
) {
  const done = useRef(onClosed);
  done.current = onClosed;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!closing) return;
    if (!el) return void done.current();
    const from = el.getBoundingClientRect().width;
    for (const animation of el.getAnimations()) animation.cancel();
    const rest = restBox.get(session) ?? REST_FALLBACK;
    const to = toStart ? rest.both : rest.mic;
    const clip = { overflow: "hidden", justifyContent: "flex-end" };
    const animation = el.animate(
      [
        { ...clip, width: `${from}px` },
        { ...clip, width: `${to}px`, borderColor: "transparent", backgroundColor: toStart ? rest.background : "transparent" },
      ],
      { duration: EXPAND_MS, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)", fill: "forwards" },
    );
    animation.onfinish = () => done.current();
    return () => animation.cancel();
  }, [ref, session, closing, toStart]);
}

/**
 * Slide the pill open leftward (its right edge stays put) from the start box,
 * then keep sliding as it changes width (status text, the mute button appearing)
 * instead of popping to the new size.
 */
function useSlidingWidth(ref: React.RefObject<HTMLElement | null>, session: VoiceSession, shown: boolean) {
  const last = useRef<number | null>(null);
  const running = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) {
      last.current = null;
      return;
    }
    const opening = last.current === null ? expandFrom.get(session) : undefined;
    expandFrom.delete(session);
    // Mid-slide, start from where it is now, not where the last slide began.
    const current = running.current?.playState === "running" ? el.getBoundingClientRect().width : last.current;
    running.current?.cancel();
    running.current = null;
    const to = el.getBoundingClientRect().width;
    const from = opening?.width ?? current;
    last.current = to;
    if (from === null || Math.abs(to - from) < 1 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const clip = { overflow: "hidden", justifyContent: "flex-end" };
    running.current = el.animate(
      [
        { ...clip, width: `${from}px`, ...(opening ? { backgroundColor: opening.background, borderColor: "transparent" } : {}) },
        { ...clip, width: `${to}px` },
      ],
      { duration: EXPAND_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  });
}

function VoicePill({
  session,
  closing = false,
  toStart = false,
  onClosed = () => {},
}: {
  session: VoiceSession;
  closing?: boolean;
  toStart?: boolean;
  onClosed?: () => void;
}) {
  const state = useVoiceState(session);
  // While sliding closed, keep showing what the pill showed last.
  const lastShown = useRef(state);
  if (state.phase !== "off") lastShown.current = state;
  const { phase, muted, caption, agentStatus } = closing && state.phase === "off" ? lastShown.current : state;
  const pill = useRef<HTMLDivElement>(null);
  useSlidingWidth(pill, session, state.phase !== "off");
  useSlideClosed(pill, session, closing && state.phase === "off", toStart, onClosed);

  useEffect(() => {
    if (phase !== "error") return;
    const timer = setTimeout(() => session.dismissError(), ERROR_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [phase, session]);

  if (phase === "off") return null;
  const micActive = phase === "listening" || phase === "speaking";
  // Errors are usually setup problems (no key, no connection plugin), so say
  // what went wrong in the pill rather than only in a tooltip.
  const status = phase === "error" ? caption || "Voice error" : muted && micActive ? "Muted" : LABELS[phase];
  const detail = [agentStatus ? `Agent: ${agentStatus}` : "", caption].filter(Boolean).join("\n");

  return (
    <div
      ref={pill}
      data-voice-mode-pill=""
      data-phase={phase}
      data-muted={muted}
      className={cn(
        "voice-mode-pill inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-state-hover pl-2.5 pr-1",
        phase === "error"
          ? "text-destructive"
          : muted && micActive
            ? "text-muted-foreground"
            : phase === "speaking"
              ? "text-sky-500"
              : "text-foreground",
      )}
    >
      <span role="status" aria-live="polite" title={detail || undefined} className="inline-flex items-center gap-2 pr-1">
        {phase === "error" ? <Glyph name="alert" /> : <LevelWave session={session} phase={phase} muted={muted && micActive} />}
        <span className={cn("text-xs font-medium text-foreground/80", phase === "error" && "max-w-72 truncate")}>{status}</span>
      </span>
      {micActive ? (
        <button
          type="button"
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          title={muted ? "Unmute microphone" : "Mute microphone (voice mode stays on)"}
          onClick={() => session.setMuted(!muted)}
          className={muted ? `${PILL_BUTTON} bg-background text-red-500` : PILL_BUTTON_IDLE}
        >
          <Glyph name={muted ? "mic-off" : "mic"} />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={phase === "error" ? "Dismiss voice mode error" : "End voice mode"}
        title={phase === "error" ? caption || "Dismiss" : "End voice mode"}
        onClick={() => void (phase === "error" ? session.dismissError() : session.stop())}
        className={PILL_BUTTON_IDLE}
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
  return threadId ? <ThreadComposerVoice threadId={threadId} canStart={composer.isEmpty && !composer.isRunning} /> : null;
}

/**
 * Copy the size and look of bb's (hidden) send control so the waveform matches
 * it under any theme, e.g. a theme that makes send a circle.
 */
function useSendButtonLook(ref: React.RefObject<HTMLElement | null>) {
  const [look, setLook] = useState<React.CSSProperties>({});
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const read = () => {
      const menu = form.querySelector<HTMLElement>(SEND_SELECTOR);
      if (!menu) return;
      // The menu is display:none while we stand in for it, and bb collapses its
      // model chevron (w-0) while the composer is empty, growing it (w-6) as you
      // type. Un-hide and expand it for one synchronous layout read (no paint in
      // between) so the waveform takes the size send has once you type.
      const hider = menu.closest<HTMLElement>(`[${VOICE_SEND_ATTR}]`);
      hider?.removeAttribute(VOICE_SEND_ATTR);
      const chevron = Array.from(menu.children).find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("w-0"));
      const transition = chevron?.style.transition ?? "";
      if (chevron) {
        chevron.style.transition = "none";
        chevron.classList.replace("w-0", "w-6");
      }
      const rect = menu.getBoundingClientRect();
      const m = getComputedStyle(menu);
      const next: React.CSSProperties = {
        // The whole send control (arrow plus model chevron), so swapping
        // between it and the waveform doesn't change the button's size.
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        padding: 0,
        borderRadius: m.borderTopLeftRadius,
        backgroundColor: m.backgroundColor,
        color: m.color,
      };
      if (chevron) {
        chevron.classList.replace("w-6", "w-0");
        void chevron.offsetWidth;
        chevron.style.transition = transition;
      }
      hider?.setAttribute(VOICE_SEND_ATTR, "");
      if (!rect.width || !rect.height) return;
      setLook((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    read();
    // Theme switches restyle the document; re-read when they do.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    observer.observe(document.head, { childList: true, subtree: true });
    // Touch layouts size send differently (h-10); follow viewport changes too.
    window.addEventListener("resize", read);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [ref]);
  return look;
}

function StartVoiceButton({ session }: { session: VoiceSession }) {
  const ref = useRef<HTMLButtonElement>(null);
  const look = useSendButtonLook(ref);
  return (
    <span className="voice-mode-start ml-1 inline-flex" data-tip="Start new voice chat">
      <button
        ref={ref}
        type="button"
        aria-label="Start new voice chat"
        onClick={(event) => {
          rememberExpandFrom(session, event.currentTarget);
          void session.start();
        }}
        style={look}
        className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md bg-foreground px-2 text-background transition-[filter] duration-150 hover:brightness-90 hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:h-10 max-md:pointer-coarse:px-3"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className="size-4">
          {[4, 8, 12, 8, 4].map((h, i) => (
            <rect key={i} x={1.5 + i * 2.75} y={(16 - h) / 2} width={1.75} height={h} rx={0.875} />
          ))}
        </svg>
      </button>
    </span>
  );
}

function ThreadComposerVoice({ threadId, canStart }: { threadId: string; canStart: boolean }) {
  const session = sessionFor(threadId);
  const { phase } = useVoiceState(session);
  const anchor = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  // When a live session ends (end button, idle end, the socket closing), keep
  // the pill up while it slides closed. Derived during render so the mic and
  // waveform never flash in before the slide starts.
  const [prevPhase, setPrevPhase] = useState(phase);
  const [closing, setClosing] = useState(false);
  if (phase !== prevPhase) {
    setPrevPhase(phase);
    setClosing(phase === "off" && isLive(prevPhase) && !matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  const showing = phase !== "off" || closing;

  useEffect(() => session.retain(), [session]);

  useEffect(() => {
    const start = anchor.current;
    if (!start) return;
    // bb's buttons can render after this action does, so key off the composer
    // form and look them up on every change.
    const composerRoot = start.closest("form");
    if (!composerRoot) return;
    const portal = document.createElement("span");
    portal.className = "voice-mode-host";
    let frame = 0;
    const place = () => {
      frame = 0;
      const group = composerRoot.querySelector(SEND_SELECTOR)?.closest("[data-promptbox-submit-group]");
      if (group && portal.nextSibling !== group) group.before(portal);
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
      composerRoot.removeAttribute(VOICE_SEND_ATTR);
      composerRoot.removeAttribute(LIVE_ATTR);
      setHost(null);
    };
  }, [threadId]);

  // Empty and idle: our waveform stands in for bb's send button. Live: the
  // pill stands in for bb's mic (and for send, until you type).
  const showStart = canStart && phase === "off" && !closing;
  const hideSend = canStart && phase !== "error";
  useEffect(() => {
    const root = host?.closest("form");
    if (!root) return;
    root.toggleAttribute(VOICE_SEND_ATTR, hideSend);
    root.toggleAttribute(LIVE_ATTR, showing);
  }, [host, hideSend, showing]);

  const content = showStart ? <StartVoiceButton session={session} /> : (
    <VoicePill session={session} closing={closing} toStart={canStart} onClosed={() => setClosing(false)} />
  );
  return (
    <>
      <span ref={anchor} hidden />
      {host ? createPortal(content, host) : isLive(phase) || phase === "error" || closing ? content : null}
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
    title: "Start or end voice chat",
    // Codex's binding. Rebind or clear it in Settings → Keyboard.
    defaultShortcut: { key: "v", control: true, shift: true },
    run({ composer }) {
      if (composer.scope.kind !== "thread") return;
      const session = sessionFor(composer.scope.threadId);
      void (isLive(session.state.phase) ? session.stop() : session.start());
    },
  });

  app.contentScripts.register({
    id: "voice-mode-cleanup",
    mount() {
      return () => void stopAllSessions();
    },
  });
});
