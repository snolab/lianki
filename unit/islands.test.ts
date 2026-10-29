import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { z } from "zod";
import {
  ISLANDS_API,
  MODULES_GLOBAL,
  SHARED_MODULES,
  checkIslandsModule,
  errLine,
  grantUntil,
  isComponent,
  islandsEventsUrl,
  islandsSrc,
  islandsUrl,
  parseReload,
} from "@/lib/islands/rules";
import { ACTIONS, ISLAND_VERSIONS, SHARED, type SharedEntry } from "@/lib/islands/contract";
import { createIslandStore } from "@/lib/islands/store";
import { HotIsland, Island, IslandBoundary, island, reportError } from "@/lib/islands/Island";
import { startIslands } from "@/lib/islands/loader";
import {
  SHARED_EVENT,
  SHARED_PREFIX,
  boundShared,
  clearShared,
  decodeShared,
  encodeShared,
  readShared,
  subscribeShared,
  useSharedState,
  writeShared,
} from "@/lib/islands/shared-state";
import {
  ACTION_EVENT,
  listenLatest,
  onAction,
  sendAction,
  useIslandAction,
} from "@/lib/islands/actions";
import {
  changedIslands,
  buildIslands,
  exportNames,
  hostStub,
  islandFingerprints,
  islandSources,
  typeErrorFiles,
} from "@/scripts/dev/islands-build";

const ROOT = resolve(import.meta.dir, "..");

describe("islandsSrc: the origin allowlist", () => {
  it("https on *.ts.net, or this machine; nothing else", () => {
    expect(
      islandsSrc("https://my-mac.example-tailnet.ts.net/lianki-islands/islands.js")?.host,
    ).toBe("my-mac.example-tailnet.ts.net");
    expect(islandsSrc(" http://localhost:5181/islands.js ")?.port).toBe("5181");
    expect(islandsSrc("https://127.0.0.1/x.js")).not.toBeNull();
    expect(islandsSrc("http://[::1]:5181/x.js")).not.toBeNull();
    for (const bad of [
      "http://my-mac.example-tailnet.ts.net/x.js", // tailnet, but not https
      "https://evil.example/x.js", // https, but not the tailnet
      "https://ts.net.evil.example/x.js",
      "javascript:alert(1)",
      "data:text/javascript,1",
      "not a url",
      "",
      null,
      undefined,
    ])
      expect(islandsSrc(bad)).toBeNull();
  });

  it("cache-busts per rev and finds /events next to the module", () => {
    const src = new URL("https://my-mac.example-tailnet.ts.net/lianki-islands/islands.js");
    expect(islandsUrl(src)).toBe(src.href);
    expect(islandsUrl(src, "r1")).toBe(`${src.href}?v=r1`);
    expect(islandsEventsUrl(src)).toBe(
      "https://my-mac.example-tailnet.ts.net/lianki-islands/events",
    );
  });
});

describe("grantUntil: only a live eval grant covering this page counts", () => {
  const now = 1_000;
  it("no state, no sessions, chat-only, other pages, expired → null", () => {
    expect(grantUntil(null, now)).toBeNull();
    expect(grantUntil({ sessions: [] }, now)).toBeNull();
    const s = { pair: "p", code: "c", label: "l", at: 0 };
    expect(grantUntil({ sessions: [{ ...s, scope: "chat", until: 5_000 }] }, now)).toBeNull();
    expect(
      grantUntil({ self: "me", sessions: [{ ...s, until: 5_000, pages: ["other"] }] }, now),
    ).toBeNull();
    expect(grantUntil({ sessions: [{ ...s, until: 5_000, pages: ["other"] }] }, now)).toBeNull();
    expect(grantUntil({ sessions: [{ ...s, until: 500 }] }, now)).toBeNull();
  });
  it("the latest until among covering eval grants", () => {
    const s = { pair: "p", code: "c", label: "l", at: 0 };
    expect(
      grantUntil(
        {
          self: "me",
          sessions: [
            { ...s, until: 3_000, pages: ["me"] },
            { ...s, scope: "eval", until: 9_000 },
            { ...s, until: 4_000 },
          ],
        },
        now,
      ),
    ).toBe(9_000);
    expect(grantUntil({ sessions: [s] }, now)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("checkIslandsModule", () => {
  const C = () => null;
  it("keeps the islands this page knows at its contract version", () => {
    const m = checkIslandsModule(
      {
        ISLANDS_API,
        islands: { "header.brand": C, "x.unknown": C },
        versions: { "header.brand": 1 },
        css: "a{}",
        rev: "r",
      },
      ISLAND_VERSIONS,
    );
    expect(m.islands).toEqual({ "header.brand": C });
    expect(m.skipped).toEqual(["x.unknown: this page has no such island"]);
    expect([m.css, m.rev]).toEqual(["a{}", "r"]);
  });
  it("skips a version mismatch or a non-component; rejects a wrong module", () => {
    const m = checkIslandsModule(
      { ISLANDS_API, islands: { "header.brand": C }, versions: { "header.brand": 2 } },
      { "header.brand": 1 },
    );
    expect(m.islands).toEqual({});
    expect(m.skipped[0]).toContain("contract v2, this page wants v1");
    expect(m.css + m.rev).toBe("");
    const n = checkIslandsModule(
      { ISLANDS_API, islands: { "header.brand": 5 } },
      { "header.brand": 1 },
    );
    expect(n.skipped[0]).toContain("contract vundefined");
    const o = checkIslandsModule(
      { ISLANDS_API, islands: { "header.brand": "x" }, versions: { "header.brand": 1 } },
      { "header.brand": 1 },
    );
    expect(o.skipped).toEqual(["header.brand: not a component"]);
    expect(() => checkIslandsModule({ ISLANDS_API: 0, islands: {} }, {})).toThrow("islands API 0");
    expect(() => checkIslandsModule({ ISLANDS_API }, {})).toThrow("exports no islands");
  });
  it("isComponent, parseReload, errLine", () => {
    expect(isComponent(C)).toBe(true);
    expect(isComponent({ $$typeof: Symbol.for("react.memo") })).toBe(true);
    expect(isComponent(null)).toBe(false);
    expect(isComponent("div")).toBe(false);
    expect(parseReload('{"rev":"r","names":["a",1]}')).toEqual({ rev: "r", names: ["a"] });
    expect(parseReload('{"rev":1,"names":[]}')).toBeNull();
    expect(parseReload("nope")).toBeNull();
    expect(errLine(new TypeError("x"))).toBe("TypeError: x");
    expect(errLine("plain")).toBe("plain");
  });
});

describe("the island store", () => {
  const fakeTimers = () => {
    const t = { fn: null as null | (() => void), ms: -1, cleared: 0 };
    return {
      t,
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          t.fn = fn;
          t.ms = ms;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => void t.cleared++,
      },
    };
  };
  const C = (() => null) as unknown as ComponentType<Record<string, unknown>>;

  it("no grant: puts are ignored, nothing is overridden", () => {
    const s = createIslandStore(fakeTimers().timers);
    s.put({ a: { C, rev: "1" } });
    expect(s.get("a")).toBeUndefined();
    expect(s.granted()).toBe(false);
  });

  it("a grant lets puts in, lapses on its own timeout, and clears everything", () => {
    const { t, timers } = fakeTimers();
    const s = createIslandStore(timers);
    let n = 0;
    const off = s.subscribe(() => n++);
    s.setGrant(5_000, 1_000);
    expect(s.granted()).toBe(true);
    expect(t.ms).toBe(4_000);
    s.setGrant(5_000, 1_000); // unchanged: no emit
    s.put({ a: { C, rev: "1" }, b: { C, rev: "1" } });
    expect(s.names()).toEqual(["a", "b"]);
    s.drop("a");
    s.drop("a");
    expect(s.names()).toEqual(["b"]);
    t.fn?.();
    expect(s.granted()).toBe(false);
    expect(s.names()).toEqual([]);
    expect(n).toBe(4);
    off();
    s.setGrant(500, 1_000); // already expired
    expect(s.granted()).toBe(false);
    s.setGrant(Number.POSITIVE_INFINITY, 0);
    expect(s.granted()).toBe(true);
    s.clear();
    s.put({ c: { C, rev: "2" } });
    s.clear();
    expect(s.names()).toEqual([]);
  });

  it("the default store uses the real timers", async () => {
    const s = createIslandStore();
    s.setGrant(Date.now() + 5);
    expect(s.granted()).toBe(true);
    s.setGrant(Date.now() + 20);
    await Bun.sleep(40);
    expect(s.granted()).toBe(false);
  });
});

describe("<Island>", () => {
  const Builtin = ({ appName }: { appName: string }) =>
    createElement("b", null, `built-in ${appName}`);
  const Remote = ({ appName }: { appName: string }) =>
    createElement("i", null, `remote ${appName}`);

  it("renders the built-in component with no override (and with no window: no subscription)", () => {
    expect(
      renderToString(
        createElement(Island, {
          name: "header.brand",
          component: Builtin,
          props: { appName: "L" },
        }),
      ),
    ).toBe("<b>built-in L</b>");
    const Named = island("header.brand", Builtin);
    expect(Named.displayName).toBe("Island(header.brand)");
    expect(renderToString(createElement(Named, { appName: "M" }))).toBe("<b>built-in M</b>");
  });

  it("renders the override the store holds for its name", () => {
    const store = createIslandStore();
    const el = () =>
      renderToString(
        createElement(HotIsland, {
          name: "header.brand",
          component: Builtin,
          props: { appName: "L" },
          store,
        }),
      );
    expect(el()).toBe("<b>built-in L</b>");
    store.setGrant(Number.POSITIVE_INFINITY);
    store.put({
      "header.brand": { C: Remote as unknown as ComponentType<Record<string, unknown>>, rev: "r1" },
    });
    expect(el()).toBe("<i>remote L</i>");
  });

  it("the boundary shows the built-in island after a throw, and reports it", () => {
    const seen: unknown[] = [];
    const b = new IslandBoundary({
      name: "header.brand",
      fallback: "FALLBACK",
      onError: (name, e) => seen.push(name, e),
      children: "REMOTE",
    });
    expect(b.render()).toBe("REMOTE");
    b.state = IslandBoundary.getDerivedStateFromError();
    expect(b.render()).toBe("FALLBACK");
    const err = new Error("boom");
    b.componentDidCatch(err);
    expect(seen).toEqual(["header.brand", err]);
    const warn = console.warn;
    console.warn = () => {};
    reportError("header.brand", err); // console + devLog (off: no debug mode)
    console.warn = warn;
  });
});

// ── shared state and actions, against an in-memory window ────────────────────
class MemStorage {
  m = new Map<string, string>();
  broken = false;
  getItem(k: string) {
    if (this.broken) throw new Error("blocked");
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.broken) throw new Error("blocked");
    this.m.set(k, v);
  }
  removeItem(k: string) {
    if (this.broken) throw new Error("blocked");
    this.m.delete(k);
  }
}
const g = globalThis as Record<string, unknown>;
const storage = new MemStorage();
beforeAll(() => {
  g.window = new EventTarget();
  g.localStorage = storage;
});
afterAll(() => {
  delete g.window;
  delete g.localStorage;
});

describe("shared state", () => {
  const e: SharedEntry<{ n: number }> = {
    schema: z.object({ n: z.number() }),
    default: { n: 0 },
    version: 2,
    migrate: (from, raw) => {
      if (from === 1) return { n: Number((raw as { count: string }).count) };
      throw new Error("too old");
    },
  };
  const logs: Record<string, unknown>[] = [];
  const log = (x: Record<string, unknown>) => void logs.push(x);
  const dec = (raw: string | null) => decodeShared("k", e, raw, log);

  it("decodes, migrates and never throws: anything bad reads as the default", () => {
    expect(dec(null)).toEqual({ n: 0 });
    expect(dec('{"v":2,"data":{"n":3}}')).toEqual({ n: 3 });
    expect(dec('{"v":1,"data":{"count":"7"}}')).toEqual({ n: 7 });
    expect(logs).toEqual([]);
    expect(dec('{"v":0,"data":{}}')).toEqual({ n: 0 }); // migrate throws
    expect(dec('{"v":3,"data":{"n":1}}')).toEqual({ n: 0 }); // newer than this side
    expect(dec('{"v":2,"data":{"n":"x"}}')).toEqual({ n: 0 }); // wrong shape
    expect(dec("{nope")).toEqual({ n: 0 });
    expect(dec("null")).toEqual({ n: 0 });
    expect(decodeShared("k", { ...e, migrate: undefined }, '{"v":1,"data":{}}', log)).toEqual({
      n: 0,
    });
    expect(logs.map((l) => l.why)).toEqual([
      expect.stringContaining("migrate from 0 threw"),
      "version 3, want 2",
      expect.any(String),
      "not JSON",
      "not {v, data}",
      "version 1, want 2",
    ]);
  });

  it("writes go through the schema", () => {
    expect(encodeShared(e, { n: 4 })).toBe('{"v":2,"data":{"n":4}}');
    expect(() => encodeShared(e, { n: "4" } as unknown as { n: number })).toThrow();
  });

  it("read/write/clear on localStorage, with a same-tab event and a stable snapshot", () => {
    const key = "islands.status" as const;
    const seen: string[] = [];
    const off = subscribeShared(key, () => seen.push("hit"));
    expect(readShared(key)).toEqual(SHARED[key].default);
    writeShared(key, { active: true, rev: "r", names: ["a"], note: "n" });
    expect(storage.m.get(SHARED_PREFIX + key)).toContain('"v":1');
    const a = readShared(key);
    expect(a.rev).toBe("r");
    expect(readShared(key)).toBe(a); // same raw → same object
    writeShared(key, (p) => ({ ...p, rev: "r2" }));
    expect(readShared(key).rev).toBe("r2");
    // Another tab wrote it (storage event), or cleared all storage (key null).
    window.dispatchEvent(Object.assign(new Event("storage"), { key: SHARED_PREFIX + key }));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "other" }));
    window.dispatchEvent(new CustomEvent(SHARED_EVENT, { detail: { key: "other" } }));
    clearShared(key);
    expect(readShared(key)).toEqual(SHARED[key].default);
    off();
    writeShared(key, (p) => p);
    expect(seen.length).toBe(5);
  });

  it("blocked storage falls back to memory", () => {
    const key = "islands.status" as const;
    storage.broken = true;
    writeShared(key, { active: false, rev: "mem", names: [], note: "" });
    expect(readShared(key).rev).toBe("mem");
    clearShared(key);
    expect(readShared(key)).toEqual(SHARED[key].default);
    storage.broken = false;
    clearShared(key);
  });

  it("useSharedState renders the default on the server", () => {
    function Show() {
      const [v, set] = useSharedState("islands.status");
      return createElement("p", null, `${v.note || "none"} ${typeof set}`);
    }
    expect(renderToString(createElement(Show))).toBe("<p>none function</p>");
    // The bound functions the hook hands React, exercised directly.
    const b = boundShared("islands.status");
    expect(boundShared("islands.status")).toBe(b);
    let hits = 0;
    const off = b.subscribe(() => hits++);
    b.set({ active: true, rev: "b", names: [], note: "" });
    expect(b.snapshot().rev).toBe("b");
    expect(b.server()).toEqual(SHARED["islands.status"].default);
    off();
    clearShared("islands.status");
    expect(hits).toBe(1);
  });
});

describe("the action bus", () => {
  it("delivers a parsed payload; drops one that does not fit", () => {
    const got: unknown[] = [];
    const logs: Record<string, unknown>[] = [];
    const off = onAction(
      "islands.reload",
      (p) => got.push(p),
      (x) => void logs.push(x),
    );
    sendAction("islands.reload", {});
    window.dispatchEvent(
      new CustomEvent(ACTION_EVENT, { detail: { name: "islands.reload", payload: 5 } }),
    );
    window.dispatchEvent(new CustomEvent(ACTION_EVENT, { detail: { name: "other" } }));
    window.dispatchEvent(new CustomEvent(ACTION_EVENT));
    off();
    sendAction("islands.reload", {});
    expect(got).toEqual([{}]);
    expect(logs[0]?.ev).toBe("island-action-dropped");
    expect(() => sendAction("islands.reload", 1 as unknown as Record<string, never>)).toThrow();
    expect(Object.keys(ACTIONS)).toContain("islands.reload");
  });

  it("useIslandAction renders on the server (effects run only in the browser)", () => {
    function Listen() {
      useIslandAction("islands.reload", () => {});
      return createElement("p", null, "ok");
    }
    expect(renderToString(createElement(Listen))).toBe("<p>ok</p>");
    // The effect itself: always the latest handler.
    const got: string[] = [];
    const ref = { current: (_p: object) => void got.push("first") };
    const off = listenLatest("islands.reload", ref)();
    ref.current = () => void got.push("second");
    sendAction("islands.reload", {});
    off();
    expect(got).toEqual(["second"]);
  });
});

describe("the loader", () => {
  class FakeES {
    url: string;
    closed = false;
    on = new Map<string, (e: MessageEvent) => void>();
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      this.on.set(type, fn);
    }
    close() {
      this.closed = true;
    }
    fire(type: string, data: string) {
      this.on.get(type)?.({ data } as MessageEvent);
    }
  }
  const tick = () => Bun.sleep(5);

  it("shares modules, installs islands, reloads only the named ones, stops cleanly", async () => {
    const store = createIslandStore();
    store.setGrant(Number.POSITIVE_INFINITY);
    const A1 = () => null;
    const A2 = () => null;
    let mod: Record<string, unknown> = {
      ISLANDS_API,
      islands: { "header.brand": A1 },
      versions: ISLAND_VERSIONS,
      css: ".x{}",
      rev: "r1",
    };
    const urls: string[] = [];
    const css: (string | null)[] = [];
    const status: { active: boolean; note: string; rev: string; names: string[] }[] = [];
    const logs: Record<string, unknown>[] = [];
    let es: FakeES | null = null;
    let reload: (() => void) | null = null;
    const stop = startIslands({
      src: new URL("http://localhost:5181/islands.js"),
      store,
      importer: async (u) => {
        urls.push(u);
        if (u.includes("bad")) throw new Error("nope");
        return mod;
      },
      modules: async () => ({ react: { ok: 1 } }),
      eventSource: (u) => (es = new FakeES(u)),
      setCss: (c) => void css.push(c),
      status: (s) => void status.push(s),
      onReload: (fn) => {
        reload = fn;
        return () => (reload = null);
      },
      log: (x) => void logs.push(x),
      now: () => 36,
    });
    await tick();
    expect((globalThis as Record<string, unknown>)[MODULES_GLOBAL]).toEqual({ react: { ok: 1 } });
    expect(es!.url).toBe("http://localhost:5181/events");
    expect(store.get("header.brand")).toEqual({ C: A1 as never, rev: "r1" });
    expect(status.at(-1)?.note).toBe("islands: localhost:5181 · r1");

    // A reload naming another island leaves this one alone.
    mod = { ...mod, islands: { "header.brand": A2 }, rev: "r2" };
    es!.fire("slot-reload", JSON.stringify({ rev: "r2", names: ["other"] }));
    await tick();
    expect(store.get("header.brand")?.C).toBe(A1 as never);
    es!.fire("slot-reload", JSON.stringify({ rev: "r3", names: ["header.brand"] }));
    await tick();
    expect(store.get("header.brand")?.C).toBe(A2 as never);
    expect(urls.at(-1)).toBe("http://localhost:5181/islands.js?v=r3");
    es!.fire("slot-reload", "garbage");

    // hello with the same rev: nothing; a newer one: catch up.
    const n = urls.length;
    es!.fire("hello", "r2");
    await tick();
    expect(urls.length).toBe(n);
    mod = { ...mod, rev: "r4", versions: {}, islands: { "header.brand": A1 } };
    es!.fire("hello", "r4");
    await tick();
    expect(status.at(-1)?.note).toContain("skipped header.brand: contract vundefined");

    // The islands.reload action re-imports everything, cache-busted.
    (reload as unknown as () => void)();
    await tick();
    expect(urls.at(-1)).toBe("http://localhost:5181/islands.js?v=r4.10");

    // A failed import keeps what is there and says why.
    es!.fire("slot-reload", JSON.stringify({ rev: "bad", names: [] }));
    await tick();
    expect(status.at(-1)?.note).toContain("islands failed (Error: nope)");
    expect(logs.at(-1)?.ev).toBe("islands-failed");
    expect(store.get("header.brand")?.C).toBe(A2 as never);

    stop();
    expect(es!.closed).toBe(true);
    expect(reload).toBeNull();
    expect(store.names()).toEqual([]);
    expect(css.at(-1)).toBeNull();
    expect(status.at(-1)).toEqual({ active: false, rev: "", names: [], note: "" });
    // A load that lands after stop changes nothing.
    es!.fire("slot-reload", JSON.stringify({ rev: "r9", names: [] }));
    es!.fire("slot-reload", JSON.stringify({ rev: "bad", names: [] }));
    await tick();
    expect(store.names()).toEqual([]);
  });
});

describe("host modules", () => {
  // Not imported here: next/image needs a real document. Read its keys instead.
  it("the page shares exactly SHARED_MODULES", () => {
    const src = readFileSync(resolve(ROOT, "lib/islands/host-modules.ts"), "utf8");
    const keys = [...src.matchAll(/^\s+"?([\w@/.-]+)"?: \(\) => import\(/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...SHARED_MODULES].sort());
  });
});

describe("the islands build", () => {
  it("hostStub reads the page's module and re-exports its names", () => {
    const s = hostStub("next/link", ["default", "useLinkStatus", "$$typeof", "not-an-ident"]);
    expect(s).toContain('globalThis["__lkModules"]["next/link"]');
    expect(s).toContain("export const { useLinkStatus, $$typeof } = M;");
    expect(s).not.toContain("not-an-ident");
    const dev = hostStub("react/jsx-dev-runtime", ["jsx"]);
    expect(dev).toContain('["react/jsx-runtime"]');
    expect(dev).toContain("export const jsxDEV");
    expect(hostStub("zod", [])).not.toContain("export const {");
  });

  it("exportNames: scanned from TS, imported otherwise", async () => {
    expect(await exportNames("@/lib/dates")).toContain("longDate");
    expect(await exportNames("@/lib/islands/Island")).toContain("island");
    expect(await exportNames("react")).toContain("useState");
    expect(await exportNames("react/jsx-dev-runtime")).toEqual(
      expect.arrayContaining(["jsx", "Fragment"]),
    );
  });

  it("islandSources maps island names to their files", () => {
    const entry = resolve(ROOT, "lib/islands/entry.ts");
    const src = `import { A, B as C } from "@/app/components/BrandName";\nimport { type T } from "./contract";\nimport { X } from "./missing-file";\nexport const islands = { "a.one": A, "b.two": C, 'c.three': Local, "d.four": X };`;
    const out = islandSources(entry, src);
    expect(out["a.one"]).toBe(resolve(ROOT, "app/components/BrandName.tsx"));
    expect(out["b.two"]).toBe(out["a.one"]);
    expect(out["c.three"]).toBe(entry);
    expect(out["d.four"]).toBeUndefined();
    expect(islandSources(entry)["header.brand"]).toBe(out["a.one"]);
  });

  it("fingerprints follow the import graph; changedIslands names what moved", () => {
    const files: Record<string, string> = { "/a": "A", "/b": "B", "/shared": "S" };
    const graph = new Map([
      ["/a", ["/shared"]],
      ["/b", ["/shared", "/b"]],
    ]);
    const read = (f: string) => {
      if (!(f in files)) throw new Error("gone");
      return files[f];
    };
    const one = islandFingerprints({ a: "/a", b: "/b", c: "/gone" }, graph, read);
    files["/a"] = "A2";
    const two = islandFingerprints({ a: "/a", b: "/b", c: "/gone" }, graph, read);
    expect(changedIslands(one, two, false)).toEqual(["a"]);
    files["/shared"] = "S2";
    const three = islandFingerprints({ a: "/a", b: "/b", c: "/gone" }, graph, read);
    expect(changedIslands(two, three, false)).toEqual(["a", "b"]);
    expect(changedIslands(three, three, true)).toEqual(["a", "b", "c"]);
  });

  it("typeErrorFiles reads tsgo's output", () => {
    const out =
      "lib/islands/entry.ts(14,3): error TS2322: x\n  more\napp/a.tsx(1,1): error TS1: y\n";
    expect(typeErrorFiles(out, "/r")).toEqual(["/r/lib/islands/entry.ts", "/r/app/a.tsx"]);
  });

  it("builds the real entry with no React of its own", async () => {
    const b = await buildIslands();
    expect(b.code).toContain('globalThis["__lkModules"]["react/jsx-runtime"]');
    expect(b.code).not.toContain("react.production");
    expect(b.code).toContain("export {");
    expect(b.code).toMatch(/export const rev = "\w+";/);
    expect(Object.keys(b.fingerprints)).toEqual(Object.keys(ISLAND_VERSIONS));
    expect(b.inputs).toContain(resolve(ROOT, "app/components/BrandName.tsx"));
    expect(readFileSync(resolve(ROOT, "lib/islands/host-modules.ts"), "utf8")).toContain(
      "loadHostModules",
    );
  });
});

// devLog is how islands report; loading it here means covering it here.
describe("debug-client (the devLog islands report to)", () => {
  it("debug mode from ?debug= or localStorage; devLog posts only in debug mode", async () => {
    const { DEBUG_EVENT, debugOn, devLog, setDebug } = await import("@/lib/debug-client");
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      posts.push(init.body);
      if (init.body.includes('"fail"')) throw new Error("offline");
      return new Response("ok");
    }) as unknown as typeof fetch;
    g.location = { search: "?debug=1" };
    expect(debugOn()).toBe(true);
    g.location = { search: "" };
    let toggled = 0;
    window.addEventListener(DEBUG_EVENT, () => toggled++);
    setDebug(false);
    expect(debugOn()).toBe(false);
    devLog({ ev: "x" });
    setDebug(true);
    devLog({ ev: "y" });
    devLog({ ev: "fail" }); // a failed post is swallowed
    await Bun.sleep(1);
    expect(toggled).toBe(2);
    expect(posts.length).toBe(2);
    expect(JSON.parse(posts[0]).ev).toBe("y");
    storage.broken = true;
    expect(debugOn()).toBe(false);
    setDebug(true);
    devLog({ ev: "z" });
    storage.broken = false;
    setDebug(false);
    globalThis.fetch = realFetch;
    delete g.location;
  });
});
