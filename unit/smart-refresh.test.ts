import { describe, expect, it } from "bun:test";
import { BUILD_ATTR, pageBuildId } from "@/lib/build-id";
import {
  type RouteFingerprints,
  computeFingerprints,
  fnv1a,
  matchRoute,
  matches,
  parseFingerprints,
  parseNews,
  refreshDecision,
  routePattern,
  versionNews,
} from "@/lib/smart-refresh";

const fp = (build: string, shell: string, routes: Record<string, string>, force = false) =>
  ({ build, shell, routes, ...(force ? { force: true } : {}) }) as RouteFingerprints;

const OLD = fp("old", "s1", { "/words": "w1", "/list": "l1", "/read/[id]": "r1" });

/** The page at `path` on build "old" hears about `to`: what does it do? */
const decide = (
  to: RouteFingerprints | undefined,
  path: string,
  from: RouteFingerprints | null = OLD,
) =>
  refreshDecision(
    parseNews(JSON.stringify(versionNews(to?.build ?? "new", from ?? undefined, to)))!,
    "old",
    path,
  );

describe("refresh decision: fingerprints diff → prompt or not", () => {
  it("prompts when the current route changed", () => {
    expect(decide(fp("new", "s1", { ...OLD.routes, "/words": "w2" }), "/words")).toBe("prompt");
  });
  it("prompts every page when the shell changed", () => {
    expect(decide(fp("new", "s2", OLD.routes), "/list")).toBe("prompt");
  });
  it("stays quiet when only another route changed", () => {
    expect(decide(fp("new", "s1", { ...OLD.routes, "/words": "w2" }), "/list")).toBe("quiet");
  });
  it("stays quiet on a server-only deploy (no client chunk changed)", () => {
    expect(decide(fp("new", "s1", OLD.routes), "/words")).toBe("quiet");
    expect(decide(fp("new", "s1", OLD.routes), "/read/abc")).toBe("quiet");
  });
  it("prompts everyone when the deploy is forced", () => {
    expect(decide(fp("new", "s1", OLD.routes, true), "/list")).toBe("prompt");
    // Forced even when the page's own build has no fingerprints.
    expect(decide(fp("new", "s1", OLD.routes, true), "/list", null)).toBe("prompt");
  });
  it("prompts when it cannot tell: no fingerprints for either build", () => {
    expect(decide(undefined, "/list")).toBe("prompt");
    expect(decide(fp("new", "s1", OLD.routes), "/list", null)).toBe("prompt");
  });
  it("prompts on a route the new build added, and on a path no route names", () => {
    expect(decide(fp("new", "s1", { ...OLD.routes, "/vibe": "v1" }), "/vibe")).toBe("prompt");
    expect(decide(fp("new", "s1", OLD.routes), "/nowhere")).toBe("prompt");
  });
  it("does nothing when the news is the page's own build", () => {
    expect(refreshDecision({ build: "old" }, "old", "/words")).toBe("same");
  });
});

describe("versionNews", () => {
  it("names only the build without the page's fingerprints, keeping force", () => {
    expect(versionNews("new", undefined, fp("new", "s", {}))).toEqual({ build: "new" });
    expect(versionNews("new", OLD, fp("new", "s", {}, true))).toMatchObject({ force: true });
    // Fingerprints of another build than the one announced: ignored.
    expect(versionNews("new", OLD, fp("other", "s1", {}))).toEqual({ build: "new" });
  });
  it("marks each route of the new build changed or not", () => {
    expect(versionNews("new", OLD, fp("new", "s1", { "/words": "w1", "/list": "l2" }))).toEqual({
      build: "new",
      shell: false,
      routes: { "/words": 0, "/list": 1 },
    });
  });
});

describe("route patterns and matching", () => {
  it("turns manifest keys into URL patterns", () => {
    expect(routePattern("/(app)/words/page")).toBe("/words");
    expect(routePattern("/(app)/read/[id]/page")).toBe("/read/[id]");
    expect(routePattern("/[locale]/page")).toBe("/[locale]");
    expect(routePattern("/page")).toBe("/");
    expect(routePattern("/(app)/@modal/x/page")).toBe("/x");
    expect(routePattern("/_not-found/page")).toBeNull();
    expect(routePattern("/(app)/(.)photo/page")).toBeNull();
    expect(routePattern("/api/x/route")).toBeNull();
  });
  it("matches static, dynamic and catch-all segments", () => {
    expect(matches("/read/[id]", "/read/a%20b")).toBe(true);
    expect(matches("/read/[id]", "/read")).toBe(false);
    expect(matches("/read/[id]", "/read/a/b")).toBe(false);
    expect(matches("/docs/[...p]", "/docs")).toBe(false);
    expect(matches("/docs/[...p]", "/docs/a/b")).toBe(true);
    expect(matches("/docs/[[...p]]", "/docs")).toBe(true);
    expect(matches("/words", "/words/")).toBe(true);
    expect(matches("/w%", "/w%")).toBe(true); // a malformed escape is compared as is
    expect(matches("/a", "/b")).toBe(false);
  });
  it("picks the most specific route, as Next does", () => {
    const all = ["/[locale]", "/words", "/words/[x]", "/words/import", "/[...rest]"];
    expect(matchRoute("/words", all)).toBe("/words");
    expect(matchRoute("/words/import", all)).toBe("/words/import");
    expect(matchRoute("/words/abc", all)).toBe("/words/[x]");
    expect(matchRoute("/en", all)).toBe("/[locale]");
    expect(matchRoute("/en/blog/x", all)).toBe("/[...rest]");
    expect(matchRoute("/a/b", ["/a/[b]", "/[a]/b"])).toBe("/a/[b]");
    expect(matchRoute("/", ["/words"])).toBeNull();
  });
});

describe("computeFingerprints", () => {
  const files: Record<string, string> = {
    "rt.js": "runtime",
    "root.js": "root layout",
    "g.css": "global css",
    "app.js": "(app) layout",
    "w.js": "words page",
    "l.js": "list page",
  };
  const manifest = (page: string, pageFiles: string[]) => ({
    entryJSFiles: {
      "[project]/app/layout": ["root.js"],
      "[project]/node_modules/next/dist/client/components/builtin/global-error": ["root.js"],
      "[project]/app/(app)/layout": ["root.js", "app.js"],
      [`[project]/app/(app)/${page}/page`]: ["root.js", "app.js", ...pageFiles],
    },
    entryCSSFiles: {
      "[project]/app/layout": [{ path: "g.css" }],
      [`[project]/app/(app)/${page}/page`]: [{ path: "x", inlined: true, content: `.${page}{}` }],
    },
  });
  const run = (f: Record<string, string>, force?: boolean) =>
    computeFingerprints({
      build: "b",
      force,
      manifests: {
        "/(app)/words/page": manifest("words", ["w.js"]),
        "/(app)/list/page": manifest("list", ["l.js"]),
        "/_not-found/page": {},
      },
      shellFiles: ["rt.js"],
      hashOf: (file) => fnv1a(f[file] ?? "missing"),
    });

  it("hashes each route's own chunks apart from the shell", () => {
    const a = run(files);
    expect(Object.keys(a.routes).sort()).toEqual(["/list", "/words"]);
    expect(a.force).toBeUndefined();
    const pageOnly = run({ ...files, "w.js": "words page v2" });
    expect(pageOnly.shell).toBe(a.shell);
    expect(pageOnly.routes["/words"]).not.toBe(a.routes["/words"]);
    expect(pageOnly.routes["/list"]).toBe(a.routes["/list"]);
    const shell = run({ ...files, "g.css": "new global css" });
    expect(shell.shell).not.toBe(a.shell);
    expect(shell.routes).toEqual(a.routes);
    const group = run({ ...files, "app.js": "(app) layout v2" });
    expect(group.shell).toBe(a.shell);
    expect(group.routes["/words"]).not.toBe(a.routes["/words"]);
    expect(group.routes["/list"]).not.toBe(a.routes["/list"]);
    expect(run(files, true).force).toBe(true);
  });
  it("is the same for the same content", () => {
    expect(run(files)).toEqual(run({ ...files }));
    expect(fnv1a("")).toBe("811c9dc55ad1e806");
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });
});

describe("parsing", () => {
  it("reads news from the hub, and ignores anything else", () => {
    expect(parseNews("nope")).toBeNull();
    expect(parseNews("1")).toBeNull();
    expect(parseNews(JSON.stringify({ build: "" }))).toBeNull();
    expect(parseNews(JSON.stringify({ build: "b" }))).toEqual({ build: "b" });
    expect(
      parseNews(
        JSON.stringify({ build: "b", force: true, shell: false, routes: { "/a": 1, "/b": 0 } }),
      ),
    ).toEqual({ build: "b", force: true, shell: false, routes: { "/a": 1, "/b": 0 } });
    // Routes without a shell verdict: cannot tell.
    expect(parseNews(JSON.stringify({ build: "b", routes: { "/a": 1 } }))).toEqual({ build: "b" });
  });
  it("validates a fingerprint file", () => {
    expect(parseFingerprints(null)).toBeNull();
    expect(parseFingerprints({ build: "b", shell: 1, routes: {} })).toBeNull();
    expect(parseFingerprints({ build: "b", shell: "s" })).toBeNull();
    expect(
      parseFingerprints({ build: "b", shell: "s", force: true, routes: { "/a": "h", "/b": 2 } }),
    ).toEqual({ build: "b", shell: "s", force: true, routes: { "/a": "h" } });
  });
});

describe("pageBuildId", () => {
  it("reads <html data-build>, else dev", () => {
    const doc = (v: string | null) =>
      ({
        documentElement: { getAttribute: (n: string) => (n === BUILD_ATTR ? v : null) },
      }) as unknown as Document;
    expect(pageBuildId(doc("abc"))).toBe("abc");
    expect(pageBuildId(doc(null))).toBe("dev");
    expect(typeof pageBuildId()).toBe("string");
  });
});
