/**
 * /dev/flags with saves that overlap (FlagsAdmin, mounted in happy-dom with a
 * fake /api/dev/flags; no real flag is read or written). Answers can come
 * back in any order: a save's answer changes only the row it saved.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { mockIntlayer } from "./intlayer-mock";
import { stubGlobals } from "./support/globals";
import { applySaved, setRowEnabled, type FlagsState } from "@/app/(app)/dev/flags/flag-view";

mockIntlayer();

const A = "ext.pill-chat";
const B = "ext.pill-chat-users";

const rows = (a = false, b = false, log: FlagsState["log"] = []): FlagsState => ({
  flags: [
    { key: A, enabled: a, description: "A", updatedAt: null, updatedBy: null },
    { key: B, enabled: b, description: "B", updatedAt: null, updatedBy: null },
  ] as FlagsState["flags"],
  cacheSeconds: 30,
  log,
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

/** The page, with each POST held until the test answers it. */
async function mount() {
  const win = new Window({ url: "https://lianki.com/dev/flags" });
  const pending = new Map<string, (r: Response) => void>();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    location: win.location,
    localStorage: win.localStorage,
    CustomEvent: win.CustomEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (_url: string, options?: RequestInit) =>
      options?.method === "POST"
        ? new Promise<Response>((resolve) =>
            pending.set(JSON.parse(String(options.body)).key, resolve),
          )
        : Response.json(rows()),
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
  const sw = (k: string) =>
    host.querySelector(`[data-flag="${k}"] [role="switch"]`) as unknown as HTMLButtonElement;
  const checked = (k: string) => sw(k).getAttribute("aria-checked");
  const click = (k: string) => act(async () => sw(k).click());
  const answer = (k: string, r: Response) => act(async () => pending.get(k)!(r));
  return { sw, checked, click, answer, pending };
}

describe("overlapping saves on /dev/flags", () => {
  test("a late answer for A does not turn B back off (the review's repro)", async () => {
    const p = await mount();
    expect(p.sw(A)).not.toBeNull();
    await p.click(A);
    await p.click(B);
    expect(p.pending.size).toBe(2);
    await p.answer(B, Response.json(rows(true, true)));
    expect(p.checked(B)).toBe("true");
    await p.answer(A, Response.json(rows(true, false)));
    expect(p.checked(B)).toBe("true");
    expect(p.checked(A)).toBe("true");
  });

  test("A and B saved at once, answered in order: both end on", async () => {
    const p = await mount();
    await p.click(A);
    await p.click(B);
    await p.answer(A, Response.json(rows(true, false)));
    await p.answer(B, Response.json(rows(true, true)));
    expect(p.checked(A)).toBe("true");
    expect(p.checked(B)).toBe("true");
  });

  test("a failed save of A puts only A back; B's save stands", async () => {
    const p = await mount();
    await p.click(A);
    await p.click(B);
    expect(p.checked(A)).toBe("true"); // shown while it saves
    await p.answer(B, Response.json(rows(false, true)));
    await p.answer(A, Response.json({ error: "nope" }, { status: 500 }));
    expect(p.checked(A)).toBe("false");
    expect(p.checked(B)).toBe("true");
  });
});

describe("applySaved", () => {
  test("takes only the saved key's row, keeps both logs newest first", () => {
    const mine = rows(true, true, [{ key: B, enabled: true, at: "2026-11-25T10:00:02Z", by: "x" }]);
    const late = rows(true, false, [
      { key: A, enabled: true, at: "2026-11-25T10:00:01Z", by: "x" },
    ]);
    const out = applySaved(mine, late, A);
    expect(out.flags.map((f) => f.enabled)).toEqual([true, true]);
    expect(out.log.map((e) => e.key)).toEqual([B, A]);
  });
  test("takes the saved key's prerequisites, leaves the others", () => {
    const fail = [{ check: "c", reason: "r", text: "t" }] as never;
    const s = { ...rows(), prereqs: { [B]: fail } };
    const out = applySaved(s, { ...rows(true), prereqs: {} }, A);
    expect(out.prereqs?.[B]).toBe(fail);
    expect(out.prereqs?.[A]).toBeUndefined();
  });
  test("setRowEnabled changes one row", () => {
    expect(setRowEnabled(rows(), B, true).flags.map((f) => f.enabled)).toEqual([false, true]);
  });
});
