import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/m/sdk.js", import.meta.url), "utf8");
function sdk(document?: unknown) {
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  let calls = 0;
  const parent = {
    postMessage() {
      calls++;
    },
  };
  const window: any = {
    parent,
    addEventListener: (_type: string, listener: (typeof listeners)[number]) =>
      listeners.push(listener),
  };
  if (document === undefined) new Function("window", source)(window);
  else new Function("window", "document", source)(window, document);
  return { window, parent, listeners, calls: () => calls };
}

test("SDK style exposes both normalized bootstrap choices synchronously without permission or RPC", () => {
  for (const value of ["lianki", "none", "", "custom", "NONE", undefined]) {
    const { window, calls } = sdk({ documentElement: { dataset: { lkStyle: value } } });
    expect(window.lianki.style).toBe(value === "none" ? "none" : "lianki");
    expect(calls()).toBe(0);
  }
  // Old hosts and non-DOM SDK fixtures preserve the established default.
  for (const document of [undefined, {}, { documentElement: null }, { documentElement: {} }])
    expect(sdk(document).window.lianki.style).toBe("lianki");
});

test("SDK style is readonly, captured before author changes, and independent of theme events", () => {
  const attrs: Record<string, string> = {};
  const root = {
    dataset: { lkStyle: "none" },
    setAttribute: (key: string, value: string) => {
      attrs[key] = value;
    },
  };
  const { window, parent, listeners } = sdk({ documentElement: root });
  expect(Object.isFrozen(window.lianki)).toBe(true);
  expect(Reflect.set(window.lianki, "style", "lianki")).toBe(false);
  root.dataset.lkStyle = "lianki";
  for (const listener of listeners)
    listener({ source: parent, data: { lk: "mini/1", event: "theme", theme: "dark" } });
  expect(attrs["data-theme"]).toBe("dark");
  expect(window.lianki.style).toBe("none");
  const first = window.lianki;
  new Function("window", "document", source)(window, { documentElement: root });
  expect(window.lianki).toBe(first);
  expect(window.lianki.style).toBe("none");
});
