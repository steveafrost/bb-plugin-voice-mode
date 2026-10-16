// Press-and-hold on bb's composer mic starts voice mode; a plain click still
// reaches bb and starts dictation. bb renders the mic with no plugin hook, so
// this listens on the document in the capture phase (ahead of React's root
// listeners) and only swallows the click that ends a completed hold.
import { sessionFor } from "./session";

export const MIC_SELECTOR = 'button[aria-label="Start voice input"]';
/** Set on a thread composer's root by the composer action, value = thread id. */
export const THREAD_ATTR = "data-voice-mode-thread";
/** Set on that root while the voice pill replaces the mic. */
export const LIVE_ATTR = "data-voice-mode-live";

const HOLD_MS = 450;
const MOVE_TOLERANCE_PX = 8;
const HOLD_ATTR = "data-voice-hold";
const BB_TOOLTIP = "Start voice input · Right-click for voice preferences";
const OUR_TOOLTIP = "Start voice input · Hold for voice mode · Right-click for voice preferences";

const WAVE_SVG =
  '<svg viewBox="0 0 22 22" fill="currentColor" aria-hidden="true">' +
  [6, 12, 18, 12, 6].map((h, i) => `<rect x="${2 + i * 4}" y="${(22 - h) / 2}" width="2.2" height="${h}" rx="1.1" style="--i:${i}"/>`).join("") +
  "</svg>";

function threadOf(mic: Element): string | null {
  return mic.closest(`[${THREAD_ATTR}]`)?.getAttribute(THREAD_ATTR) ?? null;
}

function ensureOverlay(mic: HTMLElement) {
  if (mic.querySelector(".voice-mode-hold-wave")) return;
  const overlay = document.createElement("span");
  overlay.className = "voice-mode-hold-wave";
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = WAVE_SVG;
  mic.append(overlay);
}

export function mountMicHold(signal: AbortSignal): () => void {
  let pending: { mic: HTMLElement; timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  /** The mic whose hold completed; its trailing click/contextmenu is swallowed. */
  let fired: HTMLElement | null = null;
  let hoveredThreadMic = false;

  const clearPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.mic.removeAttribute(HOLD_ATTR);
    pending = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    fired = null;
    if (event.button !== 0 || !event.isPrimary) return;
    const mic = (event.target as Element | null)?.closest<HTMLButtonElement>(MIC_SELECTOR);
    if (!mic || mic.disabled) return;
    const threadId = threadOf(mic);
    if (!threadId) return;
    clearPending();
    ensureOverlay(mic);
    mic.setAttribute(HOLD_ATTR, "pending");
    const timer = setTimeout(() => {
      pending = null;
      fired = mic;
      mic.setAttribute(HOLD_ATTR, "armed");
      void sessionFor(threadId).start();
    }, HOLD_MS);
    pending = { mic, timer, x: event.clientX, y: event.clientY };
  };

  const onPointerMove = (event: PointerEvent) => {
    if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVE_TOLERANCE_PX) clearPending();
  };

  const onPointerEnd = () => {
    clearPending();
    if (fired) {
      const mic = fired;
      requestAnimationFrame(() => mic.removeAttribute(HOLD_ATTR));
    }
  };

  const swallow = (event: Event) => {
    if (!fired) return;
    const mic = (event.target as Element | null)?.closest(MIC_SELECTOR);
    if (mic !== fired) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "click") fired = null;
  };

  // Mention the gesture in bb's mic tooltip, but only for thread composers.
  const onPointerOver = (event: PointerEvent) => {
    const mic = (event.target as Element | null)?.closest(MIC_SELECTOR);
    if (mic) hoveredThreadMic = threadOf(mic) !== null;
  };
  const patchTooltips = (root: Node) => {
    if (!hoveredThreadMic) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue === BB_TOOLTIP) node.nodeValue = OUR_TOOLTIP;
    }
  };
  const tooltipObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") patchTooltips(record.target);
      record.addedNodes.forEach((node) => patchTooltips(node));
    }
  });
  tooltipObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  const options = { capture: true, signal } as const;
  document.addEventListener("pointerdown", onPointerDown, options);
  document.addEventListener("pointermove", onPointerMove, options);
  document.addEventListener("pointerup", onPointerEnd, options);
  document.addEventListener("pointercancel", onPointerEnd, options);
  document.addEventListener("pointerover", onPointerOver, options);
  document.addEventListener("click", swallow, options);
  document.addEventListener("contextmenu", swallow, options);

  return () => {
    clearPending();
    tooltipObserver.disconnect();
    document.querySelectorAll(".voice-mode-hold-wave").forEach((overlay) => overlay.remove());
    document.querySelectorAll(`[${HOLD_ATTR}]`).forEach((mic) => mic.removeAttribute(HOLD_ATTR));
  };
}
