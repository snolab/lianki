#!/usr/bin/env bun
/**
 * Per-route client fingerprints for smart refresh (lib/smart-refresh.ts,
 * docs/shipping.md "Smart refresh"). Run after the Next build:
 *
 *   bun scripts/build/route-fingerprints.ts [--next .next] [--out <file>] [--force]
 *
 * Reads every .next/server/app/**\/page_client-reference-manifest.js (which
 * client chunks and CSS each layout and page of a route loads) and
 * .next/build-manifest.json (the runtime every page loads first), hashes the
 * content of each file, and writes {build, shell, routes} to --out (default
 * .open-next/assets/_lk/route-fp.json, a static asset of the deploy that the
 * main Worker hands to lianki-push).
 *
 * The build id inlined into the client (NEXT_PUBLIC_BUILD_ID, next.config.mjs)
 * and Next's own BUILD_ID are blanked before hashing: they differ on every
 * build, and would otherwise make every deploy look like a change to the
 * chunk that carries them.
 *
 * --force, LIANKI_FORCE_REFRESH=1, or a `Force-Refresh: yes` trailer on the
 * deployed commit sets `force`: every open page asks to refresh.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { type ClientManifest, computeFingerprints, fnv1a } from "../../lib/smart-refresh";

/** Every page_client-reference-manifest.js under `dir`, evaluated. */
export function readManifests(appDir: string): Record<string, ClientManifest> {
  const out: Record<string, ClientManifest> = {};
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === "page_client-reference-manifest.js") {
        const sandbox: { globalThis?: unknown; __RSC_MANIFEST?: Record<string, ClientManifest> } =
          {};
        sandbox.globalThis = sandbox;
        runInNewContext(readFileSync(p, "utf8"), sandbox);
        Object.assign(out, sandbox.__RSC_MANIFEST ?? {});
      }
    }
  };
  walk(appDir);
  return out;
}

/** The commit's message asks every page to refresh (`Force-Refresh: yes`). */
export function forcedByTrailer(message: string): boolean {
  return /^force-refresh:\s*(yes|true|1)\s*$/im.test(message);
}

export function fingerprintBuild(opts: { nextDir: string; build: string; force?: boolean }) {
  const { nextDir, build } = opts;
  const nextBuildId = existsSync(join(nextDir, "BUILD_ID"))
    ? readFileSync(join(nextDir, "BUILD_ID"), "utf8").trim()
    : "";
  const blank = (text: string) => {
    let t = text;
    for (const id of [build, nextBuildId]) if (id) t = t.split(id).join("@BUILD@");
    return t.replace(/local-\d{13}/g, "@BUILD@");
  };
  const cache = new Map<string, string>();
  const hashOf = (file: string) => {
    let h = cache.get(file);
    if (h === undefined) {
      const p = join(nextDir, file.replace(/^\/?_next\//, ""));
      h = existsSync(p) ? fnv1a(blank(readFileSync(p, "latin1"))) : "missing";
      cache.set(file, h);
    }
    return h;
  };
  const bm = JSON.parse(readFileSync(join(nextDir, "build-manifest.json"), "utf8")) as {
    rootMainFiles?: string[];
    polyfillFiles?: string[];
  };
  return computeFingerprints({
    build,
    force: opts.force,
    manifests: readManifests(join(nextDir, "server/app")),
    shellFiles: [...(bm.rootMainFiles ?? []), ...(bm.polyfillFiles ?? [])],
    hashOf,
  });
}

/** The deployed commit's message (empty when git is not there). */
const headMessage = () =>
  spawnSync("git", ["log", "-1", "--format=%B"], { encoding: "utf8" }).stdout ?? "";

/** The CLI: writes the file and says what it wrote; returns the exit code. */
export function main(
  argv: string[],
  env: Record<string, string | undefined>,
  message: () => string = headMessage,
): number {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const nextDir = arg("--next") ?? ".next";
  const out = arg("--out") ?? ".open-next/assets/_lk/route-fp.json";
  // The same expression as next.config.mjs's NEXT_PUBLIC_BUILD_ID.
  const build = arg("--build") ?? (env.GITHUB_SHA ?? "").slice(0, 20);
  if (!build) {
    console.error("route-fingerprints: no build id (--build, or GITHUB_SHA as in CI)");
    return 1;
  }
  const force =
    argv.includes("--force") || env.LIANKI_FORCE_REFRESH === "1" || forcedByTrailer(message());
  const fp = fingerprintBuild({ nextDir, build, force });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(fp));
  console.log(
    `route-fingerprints: ${Object.keys(fp.routes).length} routes, shell ${fp.shell}${force ? ", FORCE" : ""} → ${out}`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv, process.env));
