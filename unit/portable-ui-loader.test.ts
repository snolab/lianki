import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PORTABLE_STORE_PREFIX, portableUiBundled } from "../src/portable-ui-loader";
import type { PortableWindowFactory } from "../src/portable-window";
import portableWindowStub from "../src/portable-window";

const deps = (factory: PortableWindowFactory | null) => {
  const chatStrings = {
    en: { message: "Message your {name}…" },
    zh: { message: "给{name}发消息…" },
  };
  const values = new Map<string, unknown>();
  const reports: string[] = [];
  return {
    values,
    reports,
    d: {
      factory,
      chatStrings,
      site: "https://x.test",
      getValue: (k: string, dflt?: unknown) => values.get(k) ?? dflt,
      setValue: (k: string, v: unknown) => void values.set(k, v),
      deleteValue: (k: string) => void values.delete(k),
      report: (what: string, detail: string) => void reports.push(`${what}: ${detail}`),
    },
  };
};

test("the bundled window runs only when first needed, once, and mounts with its CSS; its storage stays in GM under its own prefix", async () => {
  let runs = 0;
  let mountedWith: Record<string, unknown> | undefined;
  let gm: Parameters<PortableWindowFactory>[0] = null;
  const factory: PortableWindowFactory = (g) => {
    runs++;
    gm = g;
    return {
      css: ["a{}"],
      rev: "r",
      api: { mountPortable: (o) => ((mountedWith = o as never), { destroy() {} }) },
    };
  };
  const t = deps(factory);
  const load = portableUiBundled(t.d);
  expect(runs).toBe(0);
  const [a, b] = await Promise.all([load(), load()]);
  expect(a).toBe(b);
  expect(runs).toBe(1);
  a!.mount({ principal: "p", draftScope: "portable~p~https://x.test", locale: "zh" } as never);
  expect(mountedWith).toMatchObject({ principal: "p", css: ["a{}"] });
  expect(mountedWith!.chatStrings).toEqual({ message: "给{name}发消息…" });
  a!.mount({ principal: "p", locale: "xx" } as never);
  expect(mountedWith!.chatStrings).toEqual({ message: "Message your {name}…" });
  // A scoped draft is kept in GM storage under the prefix…
  const draft = "lk:ui:chat:portable~p~https://x.test";
  gm!.set(draft, "1");
  expect(t.values.get(PORTABLE_STORE_PREFIX + draft)).toBe("1");
  expect(gm!.get(draft)).toBe("1");
  gm!.del(draft);
  expect(gm!.get(draft)).toBeNull();
  // …but fold, dock and position stay in memory: every page starts from the defaults.
  gm!.set("lk:pref:chat-fold", '{"tucked":true}');
  expect(t.values.has(PORTABLE_STORE_PREFIX + "lk:pref:chat-fold")).toBe(false);
  expect(gm!.get("lk:pref:chat-fold")).toBe('{"tucked":true}');
  expect(gm!.keys()).toEqual(["lk:pref:chat-fold"]);
  // A position he dragged it to is kept, for this site only.
  gm!.set("lk:debug-chat-pos", '{"x":-300,"y":-200}');
  expect(t.values.get(PORTABLE_STORE_PREFIX + "https://x.test:lk:debug-chat-pos")).toBe(
    '{"x":-300,"y":-200}',
  );
  expect(gm!.get("lk:debug-chat-pos")).toBe('{"x":-300,"y":-200}');
  gm!.del("lk:debug-chat-pos");
  expect(gm!.get("lk:debug-chat-pos")).toBeNull();
  gm!.del("lk:pref:chat-fold");
  expect(gm!.get("lk:pref:chat-fold")).toBeNull();
});

test("null without the bundle, a throwing build, or one without mountPortable", async () => {
  expect(portableWindowStub).toBeNull();
  expect(await portableUiBundled(deps(null).d)()).toBeNull();
  const throwing = deps(() => {
    throw new Error("boom");
  });
  expect(await portableUiBundled(throwing.d)()).toBeNull();
  expect(throwing.reports[0]).toContain("boom");
  const old = deps(() => ({ css: [], rev: "r", api: {} }));
  expect(await portableUiBundled(old.d)()).toBeNull();
  expect(old.reports[0]).toContain("no mountPortable");
});

test("no remote code path: the userscript neither fetches nor evaluates the chat window", () => {
  const loader = readFileSync("src/portable-ui-loader.ts", "utf8").replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    "",
  );
  const main = readFileSync("src/lianki.user.ts", "utf8");
  expect(loader).not.toMatch(/\beval\b|gmFetch|GM_xmlhttpRequest|new Function/);
  expect(main).not.toMatch(/portableUiLoader|portableUi:\s*portableUiLoader/);
  // The window is part of the script, the same build the release step bundles.
  expect(main).toContain('import portableWindow, { portableChatStrings } from "./portable-window"');
});
