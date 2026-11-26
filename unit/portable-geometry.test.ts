import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  GRIP_ATTR,
  RECT_ATTR,
  publishGeometry,
} from "../packages/debug-chat/src/embed/portable-geometry";

test("<html> carries only the grip's and the window's rects, kept current, gone on destroy", async () => {
  const win = new Window({ url: "https://example.org/" });
  const doc = win.document as unknown as Document;
  const host = doc.createElement("div");
  doc.documentElement.append(host);
  const root = host.attachShadow({ mode: "closed" });
  const rect = (x: number, y: number, w: number, h: number) => () =>
    ({ x, y, width: w, height: h }) as DOMRect;
  const box = doc.createElement("section");
  box.setAttribute("data-debug-chat", "");
  box.getBoundingClientRect = rect(1272.4, 820.6, 320, 172);
  const grip = doc.createElement("div");
  grip.setAttribute("data-testid", "debug-chat-grip");
  grip.getBoundingClientRect = rect(1280, 950.5, 24.2, 24);
  box.append(grip);
  root.append(box);
  const frames: (() => void)[] = [];
  const w = {
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    cancelAnimationFrame: () => {},
  } as never;
  const stop = publishGeometry(root, doc, w);
  const html = doc.documentElement;
  expect(html.getAttribute(GRIP_ATTR)).toBe("1280,951,24,24");
  expect(html.getAttribute(RECT_ATTR)).toBe("1272,821,320,172");
  // A drag moves it (the style changes): the next frame publishes the new rects.
  box.getBoundingClientRect = rect(300, 200, 320, 172);
  grip.getBoundingClientRect = rect(308, 330, 24, 24);
  box.style.left = "300px";
  await Promise.resolve();
  frames.splice(0).forEach((f) => f());
  expect(html.getAttribute(RECT_ATTR)).toBe("300,200,320,172");
  expect(html.getAttribute(GRIP_ATTR)).toBe("308,330,24,24");
  // Resize and pointerup schedule a refresh too.
  win.dispatchEvent(new win.Event("resize"));
  expect(frames.length).toBe(1);
  frames.splice(0).forEach((f) => f());
  root.dispatchEvent(new win.Event("pointerup") as never);
  expect(frames.length).toBe(1);
  frames.splice(0).forEach((f) => f());
  // Minimized without a window: its rect goes, the grip stays.
  box.remove();
  root.append(grip);
  await Promise.resolve();
  frames.splice(0).forEach((f) => f());
  expect(html.hasAttribute(RECT_ATTR)).toBe(false);
  expect(html.getAttribute(GRIP_ATTR)).toBe("308,330,24,24");
  // Only those two attributes were ever added.
  expect([...html.attributes].map((a) => a.name).filter((n) => n.startsWith("data-lk-"))).toEqual([
    GRIP_ATTR,
  ]);
  stop();
  expect(html.hasAttribute(GRIP_ATTR)).toBe(false);
  expect(html.hasAttribute(RECT_ATTR)).toBe(false);
  await win.happyDOM.abort();
});
