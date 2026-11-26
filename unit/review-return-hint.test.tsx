import React, { act } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { ReviewOpenHint } from "../app/(app)/review/ReviewOpenHint";
import reviewContent from "../app/(app)/review/page.content";
import { reviewReturnShortcut, type ReviewReturnShortcut } from "../lib/review-ui";
import { importReactDomClient, stubGlobals } from "./support/globals";

const { createRoot } = await importReactDomClient();
const desktop = "在新标签页打开网页。读完按 {shortcut} 回到这里，再打分。";
const mobile = "在新标签页打开网页。读完按返回回到这里，再打分。";
const cases: { name: string; ua: string; touch: number; shortcut: ReviewReturnShortcut }[] = [
  {
    name: "Windows",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130",
    touch: 0,
    shortcut: "Ctrl+W",
  },
  {
    name: "Linux",
    ua: "Mozilla/5.0 (X11; Linux x86_64) Firefox/130",
    touch: 0,
    shortcut: "Ctrl+W",
  },
  { name: "Mac", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", touch: 0, shortcut: "⌘W" },
  {
    name: "iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    touch: 5,
    shortcut: "back",
  },
  { name: "iPad", ua: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", touch: 5, shortcut: "back" },
  {
    name: "desktop-mode iPad",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    touch: 5,
    shortcut: "back",
  },
  {
    name: "Android tablet without Mobile in its UA",
    ua: "Mozilla/5.0 (Linux; Android 14; Tablet) Chrome/130",
    touch: 5,
    shortcut: "back",
  },
  {
    name: "Windows touch laptop",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130",
    touch: 10,
    shortcut: "Ctrl+W",
  },
  { name: "unknown desktop", ua: "", touch: 0, shortcut: "Ctrl+W" },
];

for (const c of cases) {
  test(`${c.name} renders only its own return action`, async () => {
    expect(reviewReturnShortcut(c.ua, c.touch)).toBe(c.shortcut);
    const win = new Window();
    Object.defineProperty(win.navigator, "userAgent", { configurable: true, value: c.ua });
    Object.defineProperty(win.navigator, "maxTouchPoints", { configurable: true, value: c.touch });
    const restore = stubGlobals({
      window: win,
      document: win.document,
      navigator: win.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const container = win.document.createElement("div");
    win.document.body.append(container);
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () => {
        root.render(<ReviewOpenHint desktop={desktop} mobile={mobile} />);
      });
      expect(container.textContent).toBe(
        c.shortcut === "back" ? mobile : desktop.replace("{shortcut}", c.shortcut),
      );
      expect(container.querySelectorAll("kbd").length).toBe(c.shortcut === "back" ? 0 : 1);
      if (c.shortcut !== "back") {
        expect(container.querySelector("kbd")!.textContent).toBe(c.shortcut);
        expect(container.querySelector("kbd")!.getAttribute("dir")).toBe("ltr");
      }
    } finally {
      await act(async () => {
        root.unmount();
      });
      restore();
      await win.happyDOM.close();
    }
  });
}

test("server rendering does not guess a device or read navigator", () => {
  const restore = stubGlobals({ navigator: undefined });
  try {
    expect(renderToString(<ReviewOpenHint desktop={desktop} mobile={mobile} />)).toBe("");
  } finally {
    restore();
  }
});

test("all 16 locales keep one fixed-key placeholder and a separate mobile instruction", () => {
  const desktopTranslations = reviewContent.content.openHint.translation;
  const mobileTranslations = reviewContent.content.openHintBack.translation;
  expect(Object.keys(desktopTranslations)).toHaveLength(16);
  expect(Object.keys(mobileTranslations).sort()).toEqual(Object.keys(desktopTranslations).sort());
  for (const locale of Object.keys(desktopTranslations) as (keyof typeof desktopTranslations)[]) {
    expect(desktopTranslations[locale].match(/\{shortcut\}/g)).toHaveLength(1);
    expect(mobileTranslations[locale]).not.toMatch(/\{shortcut\}|Ctrl\+W|⌘W/);
  }
  expect(desktopTranslations.zh).toBe(desktop);
  expect(mobileTranslations.zh).toBe(mobile);
});
