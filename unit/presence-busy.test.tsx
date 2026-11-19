/**
 * Who is busy (owner, 2026-11-16): the hub's lane rows carry `busy` into the presence list
 * (presence.ts), and the page turns a ring around a busy agent's picture, in the stack and in
 * the panel (PresenceStack.tsx BusyRing): slow, seal red; still under reduced motion; a still
 * amber dashed ring when stuck. Plus the panel's three groups: listen, talk, act.
 */
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BusyRing, PresenceStack } from "../packages/debug-chat/src/PresenceStack";
import { UI_EN, UI_ZH } from "../packages/debug-chat/src/ui-strings";
import { OTHER_DEV } from "../packages/debug-chat/src/dev-ui-locales";
import { parsePresent, presentList, type Present } from "../packages/debug-chat/src/presence";
import type { ChatMessage } from "../packages/debug-chat/src/wire";
import { stubGlobals } from "./support/globals";

const T = Date.parse("2026-11-16T00:00:00Z");

describe("busy in the presence list", () => {
  const base = { now: T, readMs: 60_000, speakerMs: 60_000, live: [], viewer: "u" };
  it("a lane row's busy reaches its entry (token, line, reader); a left lane is never busy", () => {
    const records = [
      { tag: "a".repeat(16), id: "x", userId: "u", thread: "owner", lane: "codex", seenAt: T - 1 },
    ];
    const lines: ChatMessage[] = [
      { id: "1", from: "agent", label: "agy", lane: "agy", text: "hi", at: T - 2 } as ChatMessage,
    ];
    const list = presentList({
      ...base,
      records,
      lines,
      lanes: [
        { lane: "codex", state: "listener", busy: true, stuck: true },
        { lane: "agy", state: "listener", busy: true },
        { lane: "lianki-release", state: "reader", busy: true },
        { lane: "gone", state: "left", busy: true },
      ],
    });
    const by = (k: string) => list.find((p) => p.key === k);
    expect(by("lane:codex")).toMatchObject({ busy: true, stuck: true });
    expect(by("lane:agy")).toMatchObject({ busy: true });
    expect(by("lane:agy")!.stuck).toBeUndefined();
    expect(by("agent:lianki-release")).toMatchObject({ busy: true });
    expect(list.some((p) => p.key.includes("gone"))).toBe(false);
    // Not busy: no field at all.
    const idle = presentList({
      ...base,
      records,
      lines: [],
      lanes: [{ lane: "codex", state: "listener" }],
    });
    expect(idle[0]!.busy).toBeUndefined();
  });
  it("parsePresent keeps busy and stuck only as true, stuck only with busy", () => {
    const [a, b, c] = parsePresent([
      { key: "a", name: "a", active: 1, busy: true, stuck: true },
      { key: "b", name: "b", active: 1, busy: "yes", stuck: true },
      { key: "c", name: "c", active: 1, busy: true, stuck: 1 },
    ])!;
    expect([a!.busy, a!.stuck]).toEqual([true, true]);
    expect([b!.busy, b!.stuck]).toEqual([undefined, undefined]);
    expect([c!.busy, c!.stuck]).toEqual([true, undefined]);
  });
});

describe("the busy ring", () => {
  it("none when idle; turning seal red when busy, still under reduced motion; stuck its own still ring", () => {
    expect(renderToStaticMarkup(<BusyRing p={{}} t={UI_EN} />)).toBe("");
    const busy = renderToStaticMarkup(<BusyRing p={{ busy: true }} t={UI_EN} />);
    expect(busy).toContain('data-testid="debug-chat-presence-busy"');
    expect(busy).toContain("animate-spin");
    expect(busy).toContain("animation-duration:2.4s");
    expect(busy).toContain("var(--lk-primary");
    // prefers-reduced-motion: no turning, and the arc closes into a full ring.
    expect(busy).toContain("motion-reduce:animate-none");
    expect(busy).toContain("motion-reduce:border-t-[var(--lk-primary");
    expect(busy).toContain(`title="${UI_EN.peopleBusy}"`);
    const stuck = renderToStaticMarkup(<BusyRing p={{ busy: true, stuck: true }} t={UI_EN} />);
    expect(stuck).toContain('data-stuck="true"');
    expect(stuck).toContain("border-dashed");
    expect(stuck).not.toContain("animate-spin");
    expect(stuck).toContain(`title="${UI_EN.peopleStuck}"`);
  });
  it("in the stack: only around the busy avatars", () => {
    const list: Present[] = [
      { key: "lane:claude", name: "小克", lane: "claude", busy: true, active: T },
      { key: "lane:codex", name: "coco", lane: "codex", active: T - 1 },
    ];
    const html = renderToStaticMarkup(
      <PresenceStack list={list} shown={3} t={UI_EN} mainName="Li" />,
    );
    expect(html.match(/data-testid="debug-chat-presence-busy"/g)).toHaveLength(1);
    expect(html).toContain('data-key="lane:claude" data-busy="true"');
  });
  it("in the panel: the ring on the row's picture, the words in its details; talk and act struck through when not allowed", async () => {
    const { Window } = await import("happy-dom");
    const win = new Window();
    const restore = stubGlobals({
      window: win,
      document: win.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as never);
    const $ = (s: string) => host.querySelector(s) as unknown as HTMLElement | null;
    const click = (el: unknown) =>
      act(
        () =>
          void (el as EventTarget).dispatchEvent(
            new win.MouseEvent("click", { bubbles: true, detail: 0 }) as never,
          ),
      );
    try {
      const list: Present[] = [
        {
          key: "lane:codex",
          name: "coco",
          lane: "codex",
          mode: "listener",
          busy: true,
          stuck: true,
          postAt: T,
          perms: { eval: false },
          active: T,
        },
        { key: "lane:agy", name: "杰咪", lane: "agy", mode: "listener", postAt: T, active: T - 1 },
      ];
      await act(() => root.render(<PresenceStack list={list} shown={3} t={UI_EN} mainName="Li" />));
      await click($('[data-testid="debug-chat-presence"]'));
      const row = $('[data-testid="debug-chat-presence-row"][data-key="lane:codex"]')!;
      expect(
        row
          .querySelector('[data-testid="debug-chat-presence-row-avatar"]')!
          .getAttribute("data-busy"),
      ).toBe("true");
      expect(
        row.querySelector('[data-testid="debug-chat-presence-busy"]')!.getAttribute("data-stuck"),
      ).toBe("true");
      const other = $('[data-testid="debug-chat-presence-row"][data-key="lane:agy"]')!;
      expect(other.querySelector('[data-testid="debug-chat-presence-busy"]')).toBeNull();
      // Talk allowed (it answered), act not: the hand struck through and grey. No eye anywhere.
      const icon = (r: HTMLElement, kind: string) =>
        r.querySelector(`[data-testid="debug-chat-presence-icon"][data-kind="${kind}"]`)!;
      expect(icon(row, "talk").querySelector("svg")!.getAttribute("data-slash")).toBeNull();
      expect(icon(row, "act").querySelector("svg")!.getAttribute("data-slash")).toBe("true");
      expect(icon(row, "act").querySelector("span")!.className).toContain("text-gray-400");
      expect(icon(other, "act")).toBeNull();
      expect(host.innerHTML).not.toContain('data-icon="eye"');
      expect(host.innerHTML).not.toContain('data-icon="code"');
      // The details say it in words.
      await click(row.querySelector('[data-testid="debug-chat-presence-menu"]'));
      expect(
        row.querySelector('[data-testid="debug-chat-presence-activity"]')!.textContent,
      ).toContain(UI_EN.peopleStuck);
    } finally {
      await act(() => root.unmount());
      restore();
      await win.happyDOM.close();
    }
  });
});

describe("plain words", () => {
  it("no technical words in the meanings, in any locale", () => {
    const keys = ["peopleCanTalk", "peopleCannotTalk", "peopleCanAct", "peopleCannotAct"] as const;
    const all = [UI_EN, UI_ZH, ...Object.values(OTHER_DEV)];
    for (const t of all)
      for (const k of keys) {
        expect(t[k]).toBeTruthy();
        expect(t[k]).not.toMatch(/eval|code|scope|代码|コード|权限|権限/i);
      }
    expect(UI_ZH.peopleCanAct).toBe("能帮你点页面");
  });
});
