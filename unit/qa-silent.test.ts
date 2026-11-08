import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import {
  FAKE_MIC_ARGS,
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
// qa-audio-free's control launches bare on purpose, to show its checks can fail;
// that page renders into a buffer and never plays.
const ALLOWED = new Set(["scripts/qa/silent.mjs", "scripts/qa/qa-audio-free.mjs"]);

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
    for (const part of ["HTMLMediaElement", "AudioNode", "SpeechSynthesis.prototype"]) {
      expect(SILENT_INIT).toContain(part);
    }
    expect(() => new Function(SILENT_INIT)).not.toThrow();
  });

  test("the playwright test runner mutes Chromium too", () => {
    expect(readFileSync("playwright.config.ts", "utf8")).toContain("--mute-audio");
  });

  test("qa:all runs the audio-free proof before every other suite", () => {
    // The list is scripts/qa/suites.mjs; plain suites run first, in list order
    // (scripts/qa/gate-suites.ts), so the first plain suite runs first of all.
    const src = readFileSync("scripts/qa/suites.mjs", "utf8");
    const suites = src.slice(src.indexOf("export const SUITES = ["));
    expect(suites.indexOf("qa-audio-free.mjs")).toBeGreaterThan(0);
    expect(suites.indexOf("qa-audio-free.mjs")).toBeLessThan(suites.indexOf("qa-api.mjs"));
    expect(suites.slice(0, suites.indexOf("qa-audio-free.mjs"))).not.toContain("sensitive: true");
    expect(readFileSync("scripts/qa/gate-suites.ts", "utf8")).toContain(
      "for (const s of suites.filter((x) => !x.sensitive)) run(s);",
    );
  });

  test("always headless: no launch asks for a window", () => {
    const hits = [...new Glob("{scripts,tests}/**/*.{ts,mjs,js}").scanSync(".")].filter(
      (f) =>
        !f.includes("node_modules") && /headless:\s*(?!true\b)\S/.test(readFileSync(f, "utf8")),
    );
    expect(hits).toEqual([]);
  });
});

// Owner, 2026-11-06: "if u doesn't make audio at all, then u don't need to
// mute/unmute my Mac". Nothing in a test or QA path touches the sound, and nothing
// can speak or play outside a muted browser.
describe("QA leaves the Mac's sound alone", () => {
  // Spelled apart so this file does not match itself; it is excluded by name too.
  const SOUND = new RegExp(
    [
      "osa" + "script",
      "set vol" + "ume",
      "output mu" + "ted",
      "get volume set" + "tings",
      "with-muted" + "-mac",
      "af" + "play",
      "\\bff" + "play\\b",
      "\\ba" + "play\\b",
      "\\bpa" + "play\\b",
      "es" + "peak",
      "sound" + "device",
      "py" + "audio",
      "play" + "sound",
    ].join("|"),
  );
  // `say` is everyday English, and a word in chat messages here: only running it counts.
  const RUNS_SAY =
    /(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*\[?\s*["'`]say\b|Bun\.spawn(?:Sync)?\(\s*\[\s*["'`]say\b|\$`say\b/;

  const files = () =>
    [
      ...new Glob("{scripts,tests,unit,.husky}/**/*").scanSync({ cwd: ".", dot: true }),
      "package.json",
      "playwright.config.ts",
    ].filter((f) => !f.includes("node_modules") && f !== "unit/qa-silent.test.ts");

  test("no mute, volume or playback call in scripts, tests, unit tests, hooks", () => {
    expect(files().filter((f) => SOUND.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  test("nothing runs the speech command", () => {
    expect(files().filter((f) => RUNS_SAY.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  test("a shell script's `say` is its own function, not the Mac's speech command", () => {
    const bad = files().filter((f) => {
      if (!f.endsWith(".sh") && !f.startsWith(".husky/")) return false;
      const src = readFileSync(f, "utf8");
      return /^\s*say\b(?!\(\))/m.test(src) && !/^\s*(function\s+)?say\s*\(\)/m.test(src);
    });
    expect(bad).toEqual([]);
  });

  test("a QA suite that grants the microphone gets fake media devices", () => {
    const hits = [...new Glob("scripts/qa/**/*.{ts,mjs}").scanSync(".")].filter((f) =>
      /"microphone"/.test(readFileSync(f, "utf8")),
    );
    expect(hits).toContain("scripts/qa/qa-voice-mode.mjs");
    for (const f of hits)
      expect(readFileSync(f, "utf8")).toContain("--use-fake-device-for-media-stream");
    expect(FAKE_MIC_ARGS).toEqual(["--use-fake-device-for-media-stream"]);
    expect(readFileSync("playwright.config.ts", "utf8")).toContain(FAKE_MIC_ARGS[0]);
  });
});

describe("the silent helpers", () => {
  const CHROMIUM = ["--mute-audio", "--use-fake-device-for-media-stream"];
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
    await launchSilent(f.type as never, { args: ["--x"], headless: false } as never);
    await launchSilent(f.type as never);
    expect(f.calls).toEqual([
      ["launch", { args: ["--x", ...CHROMIUM], headless: true }],
      ["launch", { args: CHROMIUM, headless: true }],
    ]);
  });

  test("WebKit launches pass through (no such flag); the init script silences them", async () => {
    const f = fakeType("webkit");
    await launchSilent(f.type as never, { headless: true } as never);
    expect(f.calls).toEqual([["launch", { headless: true }]]);
  });

  test("Firefox launches keep their own prefs, with the volume at zero and speech off", async () => {
    const f = fakeType("firefox");
    await launchSilent(f.type as never, { firefoxUserPrefs: { a: 1 } } as never);
    expect(f.calls).toEqual([
      [
        "launch",
        {
          headless: true,
          firefoxUserPrefs: {
            a: 1,
            "media.volume_scale": "0.0",
            "media.webspeech.synth.enabled": false,
          },
        },
      ],
    ]);
  });

  test("a launched browser's contexts and newPage() all get the init script, once", async () => {
    const scripts: string[] = [];
    const ctx = {
      addInitScript: async (s: string) => void scripts.push(s),
      newPage: async () => "page",
    };
    const type = {
      name: () => "webkit",
      launch: async () => ({ newContext: async () => ctx, newPage: async () => "bare page" }),
    };
    const browser = await launchSilent(type as never);
    expect(await browser.newPage()).toBe("page" as never);
    expect(scripts).toEqual([SILENT_INIT]);
    await newSilentContext(browser);
    expect(scripts).toEqual([SILENT_INIT, SILENT_INIT]);
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
    expect(f.calls).toEqual([["persistent", "/tmp/x", { headless: true, args: CHROMIUM }]]);
    expect(f.ctx.scripts).toEqual([SILENT_INIT]);
    const w = fakeType("webkit");
    await launchPersistentSilent(w.type as never, "/tmp/y");
    expect(w.calls).toEqual([["persistent", "/tmp/y", { headless: true }]]);
  });
});
