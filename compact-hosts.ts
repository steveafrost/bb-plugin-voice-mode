/**
 * Where the voice button goes in bb's compact composer.
 *
 * bb draws a compact composer (collapsed, or phone width with a coarse
 * pointer) without a plugin action slot, so the app overlay has to host the
 * button and portal it in. Forms carry no thread id, so a host is paired to a
 * form by position, which only holds while the two lists line up.
 */

/** What a compact host needs to know about one of bb's composers. */
export interface CompactComposer {
  readonly key: string;
  readonly scope: { readonly kind: string; readonly threadId?: string };
  readonly layout: "compact" | "expanded";
  readonly isEmpty: boolean;
  readonly isRunning: boolean;
}

/** One voice button and the compact form it belongs in, by index. */
export interface CompactHost {
  readonly key: string;
  readonly threadId: string;
  readonly canStart: boolean;
  readonly compactIndex: number;
  readonly compactCount: number;
}

/**
 * Pair each thread composer bb is drawing compact with a compact form.
 *
 * Returns null when the pairing cannot be trusted: no compact thread composer
 * on screen, or a form count that disagrees with ours (a composer we don't
 * host is in the way). Rendering nothing in that case leaves bb's own mic and
 * send working, which is better than a button in the wrong composer.
 */
export function planCompactHosts(
  composers: readonly CompactComposer[],
  formCount: number,
): CompactHost[] | null {
  const hosts: CompactHost[] = [];
  for (const composer of composers) {
    if (composer.layout !== "compact" || composer.scope.kind !== "thread") continue;
    const threadId = composer.scope.threadId;
    if (!threadId) continue;
    hosts.push({
      key: composer.key,
      threadId,
      canStart: composer.isEmpty && !composer.isRunning,
      compactIndex: hosts.length,
      compactCount: 0,
    });
  }
  if (!hosts.length || formCount !== hosts.length) return null;
  return hosts.map((host) => ({ ...host, compactCount: hosts.length }));
}
