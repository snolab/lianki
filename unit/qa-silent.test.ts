import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import {
  MUTE_ARGS,
  SILENT_INIT,
  launchPersistentSilent,
  launchSilent,
  newSilentContext,
} from "../scripts/qa/silent.mjs";

// Owner, 2026-10-31: the Mac read words aloud in the middle of the night. Every
// Playwright browser that QA or a repro script starts must be silent, so a
// launch that skips scripts/qa/silent.mjs fails here.
const SOURCES = ["scripts/**/*.{ts,mjs,js}", "tests/**/*.{ts,mjs,js}"];
const DIRECT = /\b\w+\.(launch|newContext|launchPersistentContext)\s*\(/;
const ALLOWED = new Set(["scripts/qa/silent.mjs"]);

function launchers(): { file: string; line: number; text: string }[] {
  const hits: { file: string; line: number; text: string }[] = [];
  for (const pattern of SOURCES) {
    for (const file of new Glob(pattern).scanSync(".")) {
      if (ALLOWED.has(file) || file.includes("node_modules")) continue;
      const src = readFileSync(file, "utf8");
      if (
        !/from\s+["'](playwright|@playwright\/test)["']|import\(\s*["']playwright["']\s*\)/.test(
          src,
        )
      )
        continue;
      src.split("\n").forEach((text, i) => {
        if (DIRECT.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
      });
    }
  }
  return hits;
}

describe("QA browsers are silent", () => {
  test("no Playwright script launches a browser or context around the silent helper", () => {
    expect(launchers()).toEqual([]);
  });

  test("Chromium is muted and every page is silenced", () => {
    expect(MUTE_ARGS).toContain("--mute-audio");
    for (const part of ["HTMLMediaElement", "AudioNode", "speechSynthesis"]) {
      expect(SILENT_INIT).toContain(part);
    }
    expect(() => new Function(SILENT_INIT)).not.toThrow();
  });

  test("the playwright test runner mutes Chromium too", () => {
    expect(readFileSync("playwright.config.ts", "utf8")).toContain("--mute-audio");
  });

  test("qa:all mutes the Mac while it runs", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["qa:all"]).toStartWith("bash scripts/qa/with-muted-mac.sh ");
  });
});

describe("the silent helpers", () => {
  const fakeType = (name: string) => {
    const calls: unknown[][] = [];
    const ctx = {
      scripts: [] as string[],
      addInitScript: async (s: string) => void ctx.scripts.push(s),
    };
    return {
      calls,
      ctx,
      type: {
        name: () => name,
        launch: async (o: unknown) => (calls.push(["launch", o]), { browser: true }),
        launchPersistentContext: async (d: string, o: unknown) => (
          calls.push(["persistent", d, o]), ctx
        ),
      },
    };
  };

  test("Chromium launches get --mute-audio, kept with their own args", async () => {
    const f = fakeType("chromium");
    await launchSilent(f.type as never, { args: ["--x"], headless: true } as never);
    await launchSilent(f.type as never);
    expect(f.calls).toEqual([
      ["launch", { args: ["--x", "--mute-audio"], headless: true }],
      ["launch", { args: ["--mute-audio"] }],
    ]);
  });

  test("WebKit launches pass through (no such flag); the init script silences them", async () => {
    const f = fakeType("webkit");
    await launchSilent(f.type as never, { headless: true } as never);
    expect(f.calls).toEqual([["launch", { headless: true }]]);
  });

  test("every new context gets the silencing init script", async () => {
    const scripts: string[] = [];
    const browser = {
      newContext: async (o: unknown) => ({
        o,
        addInitScript: async (s: string) => void scripts.push(s),
      }),
    };
    const ctx = (await newSilentContext(
      browser as never,
      { viewport: null } as never,
    )) as unknown as {
      o: unknown;
    };
    expect(ctx.o).toEqual({ viewport: null });
    expect(scripts).toEqual([SILENT_INIT]);
  });

  test("persistent contexts are muted and silenced", async () => {
    const f = fakeType("chromium");
    await launchPersistentSilent(f.type as never, "/tmp/x", { headless: false } as never);
    expect(f.calls).toEqual([
      ["persistent", "/tmp/x", { headless: false, args: ["--mute-audio"] }],
    ]);
    expect(f.ctx.scripts).toEqual([SILENT_INIT]);
    const w = fakeType("webkit");
    await launchPersistentSilent(w.type as never, "/tmp/y");
    expect(w.calls).toEqual([["persistent", "/tmp/y", {}]]);
  });
});
