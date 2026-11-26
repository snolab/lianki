import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  portableMicBrowserId,
  startPortableMicBrowser,
  PORTABLE_MIC_BROWSER_KEY,
  PORTABLE_MIC_BROWSER_REQUEST,
  PORTABLE_MIC_BROWSER_STATE,
} from "../src/portable-mic-browser";

test("the browser selector is stable in manager storage and is never used as a credential", () => {
  const values = new Map<string, unknown>();
  const gm = {
    getValue: (k: string) => values.get(k),
    setValue: (k: string, v: unknown) => {
      values.set(k, v);
    },
  };
  const id = portableMicBrowserId(gm);
  expect(id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(portableMicBrowserId(gm)).toBe(id);
  expect([...values.keys()]).toEqual([PORTABLE_MIC_BROWSER_KEY]);
  expect(portableMicBrowserId({ getValue: () => null, setValue() {} })).toBeNull();
  expect(
    portableMicBrowserId({
      getValue() {
        throw Error("unavailable");
      },
      setValue() {},
    }),
  ).toBeNull();
});

test("only the top first-party page can request the non-secret id; late UI mount and hot cleanup work", () => {
  const values = new Map<string, unknown>();
  const gm = {
    getValue: (k: string) => values.get(k),
    setValue: (k: string, v: unknown) => {
      values.set(k, v);
    },
  };
  for (const [url, top, allowed] of [
    ["https://lianki.com/chat", true, true],
    ["https://lianki.com/embed/partner", false, false],
    ["https://example.com/", true, false],
    ["https://lianki.com.example.com/", true, false],
  ] as const) {
    const w = new Window({ url });
    const ac = new AbortController();
    const seen: unknown[] = [];
    const stop = startPortableMicBrowser({
      gm,
      doc: w.document as unknown as Document,
      win: w as unknown as globalThis.Window,
      top,
      signal: ac.signal,
    });
    // Listener is deliberately added after startup, matching a lazy-loaded DebugEval.
    w.document.addEventListener(PORTABLE_MIC_BROWSER_STATE, (e) =>
      seen.push(JSON.parse((e as unknown as CustomEvent<string>).detail)),
    );
    w.document.dispatchEvent(new w.CustomEvent(PORTABLE_MIC_BROWSER_REQUEST));
    expect(seen.length).toBe(allowed ? 1 : 0);
    if (allowed) expect(seen[0]).toEqual({ bid: values.get(PORTABLE_MIC_BROWSER_KEY) });
    ac.abort();
    w.document.dispatchEvent(new w.CustomEvent(PORTABLE_MIC_BROWSER_REQUEST));
    expect(seen.length).toBe(allowed ? 1 : 0);
    stop();
    stop();
    w.happyDOM.abort();
  }
});
