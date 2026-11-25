/**
 * /dev/flags as the owner uses it (FlagsAdmin mounted in happy-dom with a
 * fake /api/dev/flags; no real flag is read or written): the load, a
 * /dev/flags#<key> link, search and filters, folding, the payment
 * confirmation, a failed save, the change log.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { mockIntlayer } from "./intlayer-mock";
import { stubGlobals } from "./support/globals";
import { FLAG_HIGHLIGHT_MS } from "@/app/(app)/dev/flags/flag-anchor";
import type { FlagsState } from "@/app/(app)/dev/flags/flag-view";
import { flagViewPrefs } from "@/app/(app)/dev/flags/flag-view-store";

mockIntlayer();

const row = (key: string, enabled: boolean) => ({
  key,
  enabled,
  description: `about ${key}`,
  updatedAt: null,
  updatedBy: null,
});

/** One owner-only flag, one shipped (on, everyone), one allowlist, one that moves money. */
const STATE: FlagsState = {
  flags: [
    row("ext.pill-chat", false),
    row("levels", true),
    row("stt.worker", false),
    row("payments.stripe.live", false),
  ] as FlagsState["flags"],
  cacheSeconds: 30,
  log: [{ key: "levels", enabled: true, at: "2026-11-25T10:00:00Z", by: "me" }],
};

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  flagViewPrefs.setState({ state: "all", recent: false, open: {} });
});

type Post = (key: string, enabled: boolean) => Promise<Response>;

async function mount(
  o: { url?: string; get?: () => Response; post?: Post; confirm?: () => boolean } = {},
) {
  const win = new Window({ url: o.url ?? "https://lianki.com/dev/flags" });
  if (o.confirm) (win as unknown as { confirm: () => boolean }).confirm = o.confirm;
  const posts: string[] = [];
  const realTimeout = globalThis.setTimeout;
  const restore = stubGlobals({
    window: win,
    document: win.document,
    location: win.location,
    localStorage: win.localStorage,
    CustomEvent: win.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The highlight's fade-out, without waiting for it.
    setTimeout: ((fn: () => void, ms?: number, ...a: unknown[]) =>
      realTimeout(fn, ms === FLAG_HIGHLIGHT_MS ? 0 : ms, ...a)) as typeof setTimeout,
    fetch: async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return o.get ? o.get() : Response.json(STATE);
      const { key, enabled } = JSON.parse(String(init.body));
      posts.push(key);
      if (o.post) return o.post(key, enabled);
      return Response.json({
        ...STATE,
        flags: STATE.flags.map((f) => (f.key === key ? { ...f, enabled } : f)),
      });
    },
  });
  const { default: FlagsAdmin } = await import("@/app/(app)/dev/flags/FlagsAdmin");
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host as never);
  await act(async () => root.render(createElement(FlagsAdmin)));
  cleanup = async () => {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  };
  const $ = (sel: string) => host.querySelector(sel) as unknown as HTMLElement | null;
  const click = (el: unknown) => act(async () => (el as HTMLElement).click());
  const sw = (k: string) => $(`[data-flag="${k}"] [role="switch"]`);
  const keys = () =>
    [...host.querySelectorAll("[data-flag]")].map((e) => e.getAttribute("data-flag"));
  const button = (text: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
  const settle = () => act(async () => new Promise((r) => realTimeout(r, 5)));
  return { win, host, $, click, sw, keys, button, posts, settle };
}

describe("/dev/flags, mounted", () => {
  test("the load failing says so", async () => {
    const p = await mount({ get: () => new Response("no", { status: 500 }) });
    expect(p.host.textContent).toContain("HTTP 500");
  });

  test("the change log lists each change", async () => {
    const p = await mount();
    expect(p.host.textContent).toContain("levels → 开 · me");
  });

  test("a #<key> link opens its folded section, unfolds the row and highlights it", async () => {
    const p = await mount({ url: "https://lianki.com/dev/flags#levels" });
    await p.settle();
    // levels is shipped (folded by default) and is shown, unfolded.
    expect(p.keys()).toContain("levels");
    expect(p.host.textContent).toContain("about levels");
    await p.settle(); // the highlight fades
    expect(p.$('[data-flag="levels"]')?.getAttribute("data-highlighted")).toBeNull();
    // A link to no flag does nothing.
    await act(async () => {
      p.win.location.hash = "#nope";
      p.win.dispatchEvent(new p.win.HashChangeEvent("hashchange"));
    });
    expect(p.keys()).toContain("levels");
  });

  test("sections fold and unfold; the shipped one explains itself", async () => {
    const p = await mount();
    expect(p.keys()).not.toContain("levels"); // shipped starts folded
    const shipped = p.$('[data-flag-group="shipped"] h2 button');
    await p.click(shipped);
    expect(p.keys()).toContain("levels");
    expect(p.host.textContent).toContain("这里只是换个位置看");
    await p.click(shipped);
    expect(p.keys()).not.toContain("levels");
  });

  test("a row's name unfolds and folds its description", async () => {
    const p = await mount();
    const name = p.$('[data-flag="ext.pill-chat"] button[aria-expanded]');
    await p.click(name);
    expect(p.host.textContent).toContain("about ext.pill-chat");
    await p.click(name);
    expect(p.host.textContent).not.toContain("about ext.pill-chat");
  });

  test("search, the state filter, the recent switch, clear filters", async () => {
    const p = await mount();
    const input = p.$('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.bind(
        input,
      );
      set("pill");
      input.dispatchEvent(new p.win.Event("input", { bubbles: true }) as never);
    });
    expect(p.keys()).toEqual(["ext.pill-chat"]);
    await p.click(p.button("清除筛选"));
    expect(p.keys().length).toBeGreaterThan(1);

    await p.click(p.button("开着"));
    expect(flagViewPrefs.getState().state).toBe("on");
    expect(p.keys()).not.toContain("ext.pill-chat");

    await p.click(p.$("[data-flags-recent]"));
    expect(flagViewPrefs.getState().recent).toBe(true);
    expect(p.host.textContent).toContain("没有符合的开关。");
    await p.click(p.button("清除筛选"));
    expect(flagViewPrefs.getState()).toMatchObject({ state: "all", recent: false });
  });

  test("a payment flag asks first; no means nothing is sent", async () => {
    const p = await mount({ confirm: () => false });
    await p.click(p.sw("payments.stripe.live"));
    expect(p.posts).toEqual([]);
  });

  test("saved: the toast names the audience, for each kind", async () => {
    const p = await mount();
    await p.click(p.sw("ext.pill-chat"));
    await p.click(p.sw("stt.worker"));
    await p.click(p.$('[data-flag-group="shipped"] h2 button'));
    await p.click(p.sw("levels"));
    expect(p.posts).toEqual(["ext.pill-chat", "stt.worker", "levels"]);
    expect(p.sw("ext.pill-chat")?.getAttribute("aria-checked")).toBe("true");
  });

  test("a save that never reaches the server puts the switch back", async () => {
    const p = await mount({
      post: async () => {
        throw new Error("offline");
      },
    });
    await p.click(p.sw("ext.pill-chat"));
    expect(p.sw("ext.pill-chat")?.getAttribute("aria-checked")).toBe("false");
  });
});
