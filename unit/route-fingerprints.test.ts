import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  fingerprintBuild,
  forcedByTrailer,
  main,
  readManifests,
} from "@/scripts/build/route-fingerprints";

/** A tiny .next: two routes, a runtime chunk, the build ids inside a chunk. */
function fakeNext(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "lk-fp-"));
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  };
  put("BUILD_ID", "nextid\n");
  put("build-manifest.json", JSON.stringify({ rootMainFiles: ["static/chunks/rt.js"] }));
  const manifest = (key: string, page: string, chunk: string) =>
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};
globalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify({
      entryJSFiles: {
        "[project]/app/layout": ["static/chunks/root.js"],
        [`[project]/app/(app)/${page}/page`]: ["static/chunks/root.js", chunk],
      },
      entryCSSFiles: {},
    })};`;
  put(
    "server/app/(app)/words/page_client-reference-manifest.js",
    manifest("/(app)/words/page", "words", "static/chunks/w.js"),
  );
  put(
    "server/app/(app)/list/page_client-reference-manifest.js",
    manifest("/(app)/list/page", "list", "/_next/static/chunks/l.js"),
  );
  put("server/app/(app)/list/page.js", "not a manifest");
  for (const [p, t] of Object.entries(files)) put(`static/chunks/${p}`, t);
  return dir;
}

const FILES = { "rt.js": "runtime", "root.js": "root", "w.js": "words", "l.js": "list" };

describe("route-fingerprints", () => {
  it("reads every route's client manifest", () => {
    const dir = fakeNext(FILES);
    try {
      expect(Object.keys(readManifests(join(dir, "server/app"))).sort()).toEqual([
        "/(app)/list/page",
        "/(app)/words/page",
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("ignores the build ids, and moves only the route whose chunk changed", () => {
    const a = fakeNext({ ...FILES, "root.js": "root A1 nextid local-1700000000000" });
    const b = fakeNext({ ...FILES, "root.js": "root B2 nextid local-1700000000999" });
    const c = fakeNext({
      ...FILES,
      "root.js": "root B2 nextid local-1700000000123",
      "w.js": "words v2",
    });
    try {
      const fa = fingerprintBuild({ nextDir: a, build: "A1" });
      const fb = fingerprintBuild({ nextDir: b, build: "B2", force: true });
      const fc = fingerprintBuild({ nextDir: c, build: "B2" });
      expect(fb.shell).toBe(fa.shell);
      expect(fb.routes).toEqual(fa.routes);
      expect(fb.force).toBe(true);
      expect(fc.shell).toBe(fa.shell);
      expect(fc.routes["/list"]).toBe(fa.routes["/list"]);
      expect(fc.routes["/words"]).not.toBe(fa.routes["/words"]);
      // A chunk the manifest names but the build lacks still hashes (as "missing").
      rmSync(join(c, "static/chunks/l.js"));
      rmSync(join(c, "BUILD_ID"));
      const missing = fingerprintBuild({ nextDir: c, build: "B2" });
      expect(missing.routes["/list"]).not.toBe(fa.routes["/list"]);
      expect(missing.routes["/list"]).toBe(
        fingerprintBuild({ nextDir: c, build: "B2" }).routes["/list"],
      );
    } finally {
      for (const d of [a, b, c]) rmSync(d, { recursive: true });
    }
  });

  it("covers lazily loaded chunks (the chat), and only where they are named", () => {
    // root.js (the root layout, so the shell) lazy-loads the chat; w.js lazy-loads
    // a words-only chunk. Neither lazy chunk is in any client manifest, and their
    // names stay put when their content changes, as Turbopack's do.
    const base = {
      ...FILES,
      "root.js": 'root ["static/chunks/chat.js"].map(load)',
      "chat.js": 'chat v1 ["static/chunks/chat-mic.js"] ["static/chunks/root.js"]',
      "chat-mic.js": "mic v1",
      "w.js": 'words import("static/chunks/w-lazy.js")',
      "w-lazy.js": "words lazy v1",
    };
    const a = fakeNext(base);
    const chat = fakeNext({ ...base, "chat.js": base["chat.js"].replace("v1", "v2") });
    const mic = fakeNext({ ...base, "chat-mic.js": "mic v2" });
    const words = fakeNext({ ...base, "w-lazy.js": "words lazy v2" });
    const same = fakeNext(base);
    try {
      const fa = fingerprintBuild({ nextDir: a, build: "A" });
      const fchat = fingerprintBuild({ nextDir: chat, build: "B" });
      const fmic = fingerprintBuild({ nextDir: mic, build: "B" });
      const fwords = fingerprintBuild({ nextDir: words, build: "B" });
      // A chat-only change (also one chunk deeper) moves the shell: every page asks.
      expect(fchat.shell).not.toBe(fa.shell);
      expect(fmic.shell).not.toBe(fa.shell);
      expect(fmic.shell).not.toBe(fchat.shell);
      // A lazy chunk of one route moves that route alone, not the shell.
      expect(fwords.shell).toBe(fa.shell);
      expect(fwords.routes["/words"]).not.toBe(fa.routes["/words"]);
      expect(fwords.routes["/list"]).toBe(fa.routes["/list"]);
      // Unchanged code stays unchanged, reference cycle and all.
      expect(fingerprintBuild({ nextDir: same, build: "C" })).toEqual({ ...fa, build: "C" });
    } finally {
      for (const d of [a, chat, mic, words, same]) rmSync(d, { recursive: true });
    }
  });

  it("writes the file from the CLI, forced by flag, env or trailer", async () => {
    const dir = fakeNext(FILES);
    const out = join(dir, "out/route-fp.json");
    const run = (argv: string[], env: Record<string, string>, msg = "") =>
      main(["bun", "x", "--next", dir, "--out", out, ...argv], env, () => msg);
    const read = async () => (await Bun.file(out).json()) as { build: string; force?: true };
    try {
      expect(main(["bun", "x", "--next", dir], {}, () => "")).toBe(1); // no build id
      // The commit message read from git by default.
      expect(main(["bun", "x", "--next", dir, "--out", out, "--build", "b"], {})).toBe(0);
      expect(run([], { GITHUB_SHA: "0123456789abcdef0123456789" })).toBe(0);
      expect(await read()).toMatchObject({ build: "0123456789abcdef0123" });
      expect((await read()).force).toBeUndefined();
      expect(run(["--build", "b", "--force"], {})).toBe(0);
      expect((await read()).force).toBe(true);
      run(["--build", "b"], { LIANKI_FORCE_REFRESH: "1" });
      expect((await read()).force).toBe(true);
      run(["--build", "b"], {}, "fix\n\nForce-Refresh: yes");
      expect((await read()).force).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("is forced by a Force-Refresh trailer only", () => {
    expect(forcedByTrailer("fix: x\n\nForce-Refresh: yes\n")).toBe(true);
    expect(forcedByTrailer("fix: x\n\nforce-refresh: true")).toBe(true);
    expect(forcedByTrailer("fix: x\n\nForce-Refresh: no")).toBe(false);
    expect(forcedByTrailer("mentions Force-Refresh: yes inline")).toBe(false);
  });
});
