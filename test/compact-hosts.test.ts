import { describe, expect, it } from "vitest";
import { planCompactHosts, type CompactComposer } from "../compact-hosts";

const thread = (key: string, over: Partial<CompactComposer> = {}): CompactComposer => ({
  key,
  scope: { kind: "thread", threadId: `thr_${key}` },
  layout: "compact",
  isEmpty: true,
  isRunning: false,
  ...over,
});

describe("planCompactHosts", () => {
  it("pairs one host per compact form, in composer order", () => {
    const hosts = planCompactHosts([thread("a"), thread("b")], 2);
    expect(hosts).toEqual([
      { key: "a", threadId: "thr_a", canStart: true, compactIndex: 0, compactCount: 2 },
      { key: "b", threadId: "thr_b", canStart: true, compactIndex: 1, compactCount: 2 },
    ]);
  });

  it("renders nothing when no composer is compact", () => {
    expect(planCompactHosts([thread("a", { layout: "expanded" })], 0)).toBeNull();
  });

  it("renders nothing when there are no composers at all", () => {
    expect(planCompactHosts([], 0)).toBeNull();
  });

  it("renders nothing when a compact form has no composer behind it", () => {
    // The mismatch case: a form we would pair with by position belongs to a
    // composer this overlay does not host, so every position is suspect.
    expect(planCompactHosts([thread("a")], 2)).toBeNull();
  });

  it("renders nothing when a composer has no compact form yet", () => {
    // Mid-render: the composer exists before bb's form does.
    expect(planCompactHosts([thread("a"), thread("b")], 1)).toBeNull();
  });

  it("ignores new-thread and other non-thread composers", () => {
    expect(planCompactHosts([thread("a", { scope: { kind: "new-thread" } })], 0)).toBeNull();
    const hosts = planCompactHosts(
      [thread("a"), thread("nt", { scope: { kind: "new-thread" } })],
      1,
    );
    expect(hosts?.map((host) => host.key)).toEqual(["a"]);
    expect(hosts?.[0]?.compactCount).toBe(1);
  });

  it("skips expanded composers without shifting the remaining indices", () => {
    const hosts = planCompactHosts([thread("a", { layout: "expanded" }), thread("b")], 1);
    expect(hosts).toEqual([
      { key: "b", threadId: "thr_b", canStart: true, compactIndex: 0, compactCount: 1 },
    ]);
  });

  it("drops a thread composer with no thread id", () => {
    expect(planCompactHosts([thread("a", { scope: { kind: "thread" } })], 0)).toBeNull();
  });

  it("canStart needs an empty composer that is not running", () => {
    const hosts = planCompactHosts(
      [thread("a"), thread("b", { isEmpty: false }), thread("c", { isRunning: true })],
      3,
    );
    expect(hosts?.map((host) => host.canStart)).toEqual([true, false, false]);
  });
});
