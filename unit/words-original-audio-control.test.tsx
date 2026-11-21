import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mockIntlayer } from "./intlayer-mock";
import { stubGlobals } from "./support/globals";

mockIntlayer("en");
const { NativeAudioProgress, OriginalAudioControl } =
  await import("../lib/words/original-audio-control");

test("progress shows real percentage, unknown-length loading, preparation and idle", () => {
  const markup = (progress?: Parameters<typeof NativeAudioProgress>[0]["progress"]) =>
    renderToStaticMarkup(createElement(NativeAudioProgress, { progress }));
  expect(markup()).toBe("");
  expect(markup({ phase: "idle", loaded: 0, total: null })).toBe("");
  expect(markup({ phase: "downloading", loaded: 25, total: 100 })).toContain('value="25"');
  expect(markup({ phase: "downloading", loaded: 25, total: 100 })).toContain("25%");
  expect(markup({ phase: "downloading", loaded: 25, total: null })).not.toContain("value=");
  expect(markup({ phase: "preparing", loaded: 100, total: 100 })).toContain(
    "Preparing original audio",
  );
});

test("card details only enable original playback when that exact card has a recording", async () => {
  const win = new Window();
  const restore = stubGlobals({
    window: win,
    document: win.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const host = win.document.createElement("div");
  const root = createRoot(host as never);
  let plays = 0;
  const render = async (ready: boolean, available: boolean, failed = false) => {
    await act(() =>
      root.render(
        createElement(OriginalAudioControl, { ready, available, failed, onPlay: () => plays++ }),
      ),
    );
  };
  try {
    await render(false, false);
    expect(host.textContent).toContain("Preparing original audio");
    expect(host.querySelector("button")!.disabled).toBe(false);
    await render(true, false);
    expect(host.textContent).toContain("No original recording for this word");
    await act(() => host.querySelector("button")!.click());
    expect(plays).toBe(0);
    await render(true, true);
    await act(() => host.querySelector("button")!.click());
    expect(plays).toBe(1);
    await render(true, true, true);
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Try again");
  } finally {
    await act(() => root.unmount());
    restore();
    await win.happyDOM.close();
  }
});
