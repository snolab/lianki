import { expect, test } from "bun:test";
import { PORTABLE_STORE_PREFIX, portableUiLoader } from "../src/portable-ui-loader";

const deps = (over: Partial<Parameters<typeof portableUiLoader>[0]> = {}) => {
  const values = new Map<string, unknown>();
  const reports: string[] = [];
  let fetches = 0;
  return {
    values,
    reports,
    fetches: () => fetches,
    d: {
      src: "https://lianki.com/partner-embed.js",
      gmFetch: async () => {
        fetches++;
        return { ok: true, status: 200, text: async () => "CODE" };
      },
      getValue: (k: string, dflt?: unknown) => values.get(k) ?? dflt,
      setValue: (k: string, v: unknown) => void values.set(k, v),
      deleteValue: (k: string) => void values.delete(k),
      report: (what: string, detail: string) => void reports.push(`${what}: ${detail}`),
      ...over,
    },
  };
};

test("loads the partner build once, mounts with its CSS, keeps its storage in GM under its own prefix", async () => {
  let mountedWith: Record<string, unknown> | undefined;
  let gm: { set(k: string, v: string): void } | undefined;
  const t = deps({
    evaluate: (code) => {
      expect(code).toBe("CODE");
      return (g: typeof gm) => {
        gm = g;
        return {
          css: ["a{}"],
          api: {
            mountPortable: (o: Record<string, unknown>) => ((mountedWith = o), { destroy() {} }),
          },
        };
      };
    },
  });
  const load = portableUiLoader(t.d);
  const [a, b] = await Promise.all([load(), load()]);
  expect(a).toBe(b);
  expect(t.fetches()).toBe(1);
  a!.mount({ principal: "p" } as never);
  expect(mountedWith).toMatchObject({ principal: "p", css: ["a{}"] });
  gm!.set("lk:x", "1");
  expect(t.values.get(PORTABLE_STORE_PREFIX + "lk:x")).toBe("1");
  const g = gm as unknown as { get(k: string): unknown; del(k: string): void; keys(): string[] };
  expect(g.get("lk:x")).toBe("1");
  g.del("lk:x");
  expect(g.get("lk:x")).toBeNull();
  expect(g.keys()).toEqual([]);
});

test("by default the build is evaluated as one function expression", async () => {
  const t = deps({
    gmFetch: async () => ({
      ok: true,
      status: 200,
      text: async () =>
        "(function (gm) { return { css: ['b{}'], api: { mountPortable: function (o) { return { destroy: function () {}, o: o } } } } })",
    }),
  });
  const ui = await portableUiLoader(t.d)();
  expect(ui).not.toBeNull();
  expect(typeof ui!.mount({} as never).destroy).toBe("function");
});

test("null (the plain panel) when the build cannot be fetched, evaluated, or has no mountPortable", async () => {
  const offline = deps({ gmFetch: async () => ({ ok: false, status: 503, text: async () => "" }) });
  const load = portableUiLoader(offline.d);
  expect(await load()).toBeNull();
  // A failed fetch may be tried again by a later show.
  expect(await load()).toBeNull();
  expect(offline.fetches()).toBe(0);
  const noEval = deps({
    evaluate: () => {
      throw new EvalError("unsafe-eval");
    },
  });
  expect(await portableUiLoader(noEval.d)()).toBeNull();
  expect(noEval.reports[0]).toContain("portable-eval");
  const old = deps({ evaluate: () => () => ({ css: [], api: {} }) });
  expect(await portableUiLoader(old.d)()).toBeNull();
  expect(old.reports[0]).toContain("no mountPortable");
});
