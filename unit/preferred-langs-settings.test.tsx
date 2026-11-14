// Settings → Preferred languages with a level on each row
// (app/components/PreferredLangsSettings.tsx, lib/lang-levels.ts): every
// level shown at once with the active one marked, a pick written in the
// synced shape, the old plain-tag list read and kept, reorder and remove
// keeping levels, and reset back to automatic.
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import React, { act } from "react";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import { mockIntlayer } from "./intlayer-mock";
import { PREFERRED_LANGS_KEY } from "@/lib/lang-order";

mockIntlayer("en");

const win = new Window({ url: "https://lianki.com/my/preferences" });
const restore = stubGlobals({
  window: win,
  document: win.document,
  navigator: win.navigator,
  localStorage: win.localStorage,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  HTMLElement: win.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => restore());

const { createRoot } = await import("react-dom/client");
const { PreferredLangsSettings, keepInView } =
  await import("@/app/components/PreferredLangsSettings");

const stored = () => JSON.parse(win.localStorage.getItem(PREFERRED_LANGS_KEY) ?? "null");
const q = <T extends Element = HTMLElement>(sel: string) =>
  win.document.querySelector(sel) as unknown as T | null;
const qa = (sel: string) => [...win.document.querySelectorAll(sel)] as unknown as HTMLElement[];

async function mount(props: { hideHeading?: boolean } = {}) {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => root.render(<PreferredLangsSettings {...props} />));
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => el!.click());
};

describe("PreferredLangsSettings: levels", () => {
  beforeEach(() => win.localStorage.clear());

  it("an old plain-tag list: every level shown on each row, Not set active", async () => {
    win.localStorage.setItem(PREFERRED_LANGS_KEY, JSON.stringify(["ja", "en"]));
    const m = await mount();
    expect(qa("[data-pref-lang]").map((r) => r.getAttribute("data-pref-lang"))).toEqual([
      "ja",
      "en",
    ]);
    const group = q('[data-pref-lang-levels="ja"]')!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toContain("Japanese");
    const opts = [...group.querySelectorAll("[data-level]")] as unknown as HTMLElement[];
    expect(opts.map((o) => o.textContent)).toEqual([
      "Native",
      "Fluent",
      "C2",
      "C1",
      "B2",
      "B1",
      "A2",
      "A1",
      "Not set",
    ]);
    expect(
      opts.filter((o) => o.getAttribute("aria-checked") === "true").map((o) => o.dataset.level),
    ).toEqual(["unset"]);
    expect(win.document.body.textContent).toContain("A1 (beginner)");
    await m.unmount();
  });

  it("a pick is stored as {lang, level}; others stay plain tags; the active one moves", async () => {
    win.localStorage.setItem(PREFERRED_LANGS_KEY, JSON.stringify(["ja", "en"]));
    const m = await mount();
    await click(q('[data-pref-lang-levels="ja"] [data-level="b1"]'));
    expect(stored()).toEqual([{ lang: "ja", level: "b1" }, "en"]);
    expect(q('[data-pref-lang="ja"]')!.getAttribute("data-pref-lang-level")).toBe("b1");
    expect(q('[data-pref-lang-levels="ja"] [data-level="b1"]')!.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(
      q('[data-pref-lang-levels="ja"] [data-level="unset"]')!.getAttribute("aria-checked"),
    ).toBe("false");
    // The active one again: nothing changes.
    await click(q('[data-pref-lang-levels="ja"] [data-level="b1"]'));
    expect(stored()).toEqual([{ lang: "ja", level: "b1" }, "en"]);
    // Back to Not set: the old shape again.
    await click(q('[data-pref-lang-levels="ja"] [data-level="unset"]'));
    expect(stored()).toEqual(["ja", "en"]);
    await m.unmount();
  });

  it("one segmented control: one tab stop, arrows / Home / End move the choice", async () => {
    win.localStorage.setItem(PREFERRED_LANGS_KEY, JSON.stringify(["ja"]));
    const m = await mount();
    const group = q('[data-pref-lang-levels="ja"]')!;
    const tabbable = () =>
      ([...group.querySelectorAll("[data-level]")] as unknown as HTMLElement[])
        .filter((o) => o.getAttribute("tabindex") === "0")
        .map((o) => o.dataset.level);
    expect(tabbable()).toEqual(["unset"]);
    const key = async (k: string) =>
      act(async () => {
        group.dispatchEvent(
          new win.KeyboardEvent("keydown", { key: k, bubbles: true }) as unknown as Event,
        );
      });
    await key("Home");
    expect(stored()).toEqual([{ lang: "ja", level: "native" }]);
    expect(tabbable()).toEqual(["native"]);
    await key("ArrowRight");
    expect(stored()).toEqual([{ lang: "ja", level: "fluent" }]);
    await key("ArrowDown");
    await key("ArrowLeft");
    await key("ArrowUp");
    expect(stored()).toEqual([{ lang: "ja", level: "native" }]);
    await key("ArrowUp");
    expect(stored()).toEqual(["ja"]);
    await key("End");
    expect(stored()).toEqual(["ja"]);
    await key("x");
    expect(stored()).toEqual(["ja"]);
    group.setAttribute("dir", "rtl");
    await key("ArrowLeft");
    expect(stored()).toEqual([{ lang: "ja", level: "native" }]);
    await key("ArrowRight");
    expect(stored()).toEqual(["ja"]);
    await m.unmount();
  });

  it("keepInView scrolls the strip only as far as the active segment needs", () => {
    const strip = { offsetLeft: 10, scrollLeft: 0, clientWidth: 100 } as unknown as HTMLElement;
    const at = (left: number, width = 40) =>
      ({ offsetLeft: left + 10, offsetWidth: width }) as unknown as HTMLElement;
    keepInView(strip, at(20));
    expect(strip.scrollLeft).toBe(0);
    keepInView(strip, at(200));
    expect(strip.scrollLeft).toBe(140);
    keepInView(strip, at(50));
    expect(strip.scrollLeft).toBe(50);
  });

  it("reorder and remove keep the levels; adding appends with no level", async () => {
    win.localStorage.setItem(
      PREFERRED_LANGS_KEY,
      JSON.stringify([{ lang: "zh", level: "native" }, "en", { lang: "ja", level: "a2" }]),
    );
    const m = await mount();
    await click(q('[data-pref-lang="ja"] button[aria-label="Move Japanese up"]'));
    expect(stored()).toEqual([{ lang: "zh", level: "native" }, { lang: "ja", level: "a2" }, "en"]);
    await click(q('[data-pref-lang-remove="en"]'));
    expect(stored()).toEqual([
      { lang: "zh", level: "native" },
      { lang: "ja", level: "a2" },
    ]);
    const add = q<HTMLSelectElement>('[data-testid="preferred-langs-add"]')!;
    await act(async () => {
      add.value = "fr";
      add.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    });
    expect(stored()).toEqual([{ lang: "zh", level: "native" }, { lang: "ja", level: "a2" }, "fr"]);
    await click(q('[data-testid="preferred-langs-reset"]'));
    expect(stored()).toEqual([]);
    await m.unmount();
  });

  it("on the automatic list, a level makes the list the user's own", async () => {
    const m = await mount({ hideHeading: true });
    expect(q('[data-testid="preferred-langs-auto"]')).not.toBeNull();
    const first = qa("[data-pref-lang]")[0]!.getAttribute("data-pref-lang")!;
    await click(q(`[data-pref-lang-levels="${first}"] [data-level="native"]`));
    expect(stored()[0]).toEqual({ lang: first, level: "native" });
    expect(q('[data-testid="preferred-langs-auto"]')).toBeNull();
    await m.unmount();
  });
});
