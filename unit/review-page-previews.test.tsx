import React, { act } from "react";
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { ReviewPagePreviews } from "../app/(app)/review/ReviewPagePreviews";
import { importReactDomClient, stubGlobals } from "./support/globals";
import type { NextCard, ReviewCard } from "../lib/review-ui";

const { createRoot } = await importReactDomClient();
const labels = {
  current: "当前网页",
  next: "下一张",
  unavailable: "暂时无法预览，请点链接打开网页。",
};
const card = (name: string): ReviewCard => ({
  id: name,
  url: `https://example.com/${name}`,
  title: name,
  due: null,
});
const next = (name: string): NextCard => ({
  url: card(name).url,
  title: name,
  previewUrl: card(name).url,
});

test("real preview component retains the same iframe across a grade, bounds preloading, and removes disabled frames", async () => {
  const win = new Window({ settings: { disableIframePageLoading: true } });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = async (
    current: ReviewCard,
    upcoming: NextCard | null | undefined,
    enabled = true,
  ) => {
    await act(async () =>
      root.render(
        <ReviewPagePreviews current={current} next={upcoming} enabled={enabled} labels={labels} />,
      ),
    );
  };
  try {
    await render(card("a"), next("b"));
    const warmed = host.querySelector("iframe")!;
    expect(warmed.getAttribute("src")).toBe(card("b").url);
    expect(warmed.getAttribute("sandbox")).toBe("");
    expect(warmed.getAttribute("allow")).toContain("autoplay 'none'");
    expect(warmed.getAttribute("allow")).toContain("microphone 'none'");
    expect(warmed.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(warmed.getAttribute("loading")).toBe("eager");
    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.querySelector("a")!.href).toBe(card("b").url);
    await render(card("b"), undefined);
    expect(host.querySelector("iframe")).toBe(warmed);
    expect(host.textContent).toContain(labels.current);
    await render(card("b"), next("c"));
    expect(host.querySelector("iframe")).toBe(warmed);
    expect(host.querySelectorAll("iframe")).toHaveLength(2);
    const c = host.querySelectorAll("iframe")[1];
    await render(card("c"), next("d"));
    expect(host.querySelector("iframe")).toBe(c);
    expect(host.querySelectorAll("iframe")).toHaveLength(2);
    expect(host.querySelector(`[data-preview-url='${card("b").url}']`)).toBeNull();
    await render(card("c"), next("d"), false);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toBe("");
    // A disabled interval cannot leave a stale page to reappear as current.
    await render(card("c"), null);
    expect(host.querySelector("iframe")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});

test("blocked previews keep the real title and link instead of an empty frame", async () => {
  const win = new Window({ settings: { disableIframePageLoading: true } });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const host = win.document.createElement("div");
  win.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () =>
      root.render(
        <ReviewPagePreviews
          current={card("a")}
          next={{ ...next("b"), previewUrl: null }}
          enabled
          labels={labels}
        />,
      ),
    );
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("a")!.textContent).toBe("b");
    expect(host.querySelector("a")!.href).toBe(card("b").url);
    expect(host.textContent).toContain(labels.unavailable);
  } finally {
    await act(async () => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});
