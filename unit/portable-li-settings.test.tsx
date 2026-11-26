import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createElement, act } from "react";
import { renderToString } from "react-dom/server";
import { stubGlobals } from "./support/globals";
import PortableLiSettings, {
  parsePortableSettingsState,
} from "../app/(app)/chat/sites/PortableLiSettings";
import { PORTABLE_LI_STRINGS } from "../src/portable-li-strings";
import {
  PORTABLE_SETTINGS_REQUEST,
  PORTABLE_SETTINGS_STATE,
} from "../src/portable-li-settings-wire";
test("first-party management requests only consent/exclusion actions; withdrawing never deletes messages", async () => {
  const t = PORTABLE_LI_STRINGS.en;
  expect(
    renderToString(
      createElement(PortableLiSettings, { strings: t, notReady: "Install the script" }),
    ),
  ).not.toContain("Allow on all websites</button>");
  const win = new Window({ url: "https://lianki.com/chat/sites" });
  const restore = stubGlobals({
    window: win,
    document: win.document,
    CustomEvent: win.CustomEvent,
    navigator: win.navigator,
    MutationObserver: win.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let root: ReturnType<typeof import("react-dom/client").createRoot> | undefined;
  try {
    const requests: any[] = [];
    const send = (state: any) =>
      win.document.dispatchEvent(
        new win.CustomEvent(PORTABLE_SETTINGS_STATE, { detail: JSON.stringify(state) as never }),
      );
    win.document.addEventListener(PORTABLE_SETTINGS_REQUEST, (event) =>
      requests.push(JSON.parse((event as unknown as CustomEvent).detail)),
    );
    const { createRoot } = await import("react-dom/client");
    const host = win.document.createElement("div");
    win.document.body.append(host);
    root = createRoot(host as never);
    await act(() =>
      root!.render(
        createElement(PortableLiSettings, { strings: t, notReady: "Install the script" }),
      ),
    );
    expect(requests).toEqual([{ op: "state" }]);
    await act(() => send({ installed: true, consent: "unknown", excluded: [] }));
    const click = (text: string) => {
      const button = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
      expect(button).toBeDefined();
      button!.click();
    };
    await act(() => click(t.allowAll));
    expect(requests.at(-1)).toEqual({ op: "allow" });
    await act(() => send({ installed: true, consent: "all", excluded: ["github.com"] }));
    await act(() => click(t.removeExclusion));
    expect(requests.at(-1)).toEqual({ op: "exclude", host: "github.com", excluded: false });
    await act(() => send({ installed: true, consent: "all", excluded: [] }));
    const field = host.querySelector("input")!;
    await act(() => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(
        field,
        "example.com",
      );
      field.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
    await act(() =>
      host
        .querySelector("form")!
        .dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(requests.at(-1)).toEqual({ op: "exclude", host: "example.com", excluded: true });
    await act(() => send({ installed: true, consent: "all", excluded: ["example.com"] }));
    await act(() => click(t.disableAll));
    expect(requests.at(-1)).toEqual({ op: "off" });
    expect(JSON.stringify(requests)).not.toMatch(/delete|token|eval|payment/);
    await act(() => send({ installed: true, consent: "off", excluded: [], error: true }));
    expect(host.textContent).toContain(t.failed);
    await act(() => click(t.retry));
    expect(requests.at(-1)).toEqual({ op: "state" });
  } finally {
    if (root) await act(() => root!.unmount());
    restore();
    await win.happyDOM.abort();
  }
});
test("management response parser accepts no forged installation or malformed exclusions", () => {
  for (const value of [
    null,
    {},
    "x",
    "x".repeat(32769),
    JSON.stringify({ installed: false, consent: "all", excluded: [] }),
    JSON.stringify({ installed: true, consent: "all", excluded: ["https://example.com"] }),
    JSON.stringify({ installed: true, consent: "all", excluded: Array(513).fill("x.test") }),
  ])
    expect(parsePortableSettingsState(value)).toBeNull();
  expect(
    parsePortableSettingsState(
      '{"installed":true,"consent":"off","excluded":[],"token":"discard"}',
    ),
  ).toEqual({ installed: true, consent: "off", excluded: [] });
});
