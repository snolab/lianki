#!/usr/bin/env node
/**
 * Browser checks for the voiceprint panel (packages/debug-chat/src/VoiceprintPanel.tsx;
 * docs/local-stt.md, "Voiceprint") on the local /harness page, against the
 * real local STT server with no models (`server.py --engine fake --speaker
 * fake`) and a voiceprint folder in a temp dir. Silent (scripts/qa/silent.mjs),
 * and getUserMedia is stubbed (counted, then refused): nothing is recorded.
 *
 *   - the menu's Voiceprint opens the panel; status from the Mac
 *   - Enrol shows the consent card (the path, keep-audio off) and nothing
 *     reaches the microphone or the Mac's enrolment before "I agree, start"
 *   - the tap asks for the mic (the gesture), and the server opened an enrolment
 *   - a voice line tagged "me" shows the verified mark; "other" does not
 *
 *   node scripts/dev/voiceprint-qa.mjs [--shots <dir>]   (light/dark at 390 px)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "../qa/silent.mjs";

const argv = process.argv.slice(2);
const shotsAt = argv.indexOf("--shots");
const SHOTS = shotsAt === -1 ? null : argv[shotsAt + 1];
const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const waitFor = (proc, text, what) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not start in 60 s`)), 60_000);
    let buf = "";
    const on = (b) => {
      buf += String(b);
      if (buf.includes(text)) {
        clearTimeout(t);
        resolve(buf);
      }
    };
    proc.stdout.on("data", on);
    proc.on("exit", (c) => reject(new Error(`${what} exited (${c}): ${buf}`)));
  });

const port = await freePort();
const sttPort = await freePort();
const ORIGIN = `http://localhost:${port}`;
const tmp = mkdtempSync(join(tmpdir(), "lk-voiceprint-qa-"));
const store = join(tmp, "voiceprints");
const widget = spawn(
  "bun",
  ["scripts/dev/debug-widget-server.ts", "--port", String(port), "--no-tunnel"],
  {
    stdio: ["ignore", "pipe", "inherit"],
  },
);
const stt = spawn(
  PY,
  [
    "-I",
    "scripts/local-stt/server.py",
    "--engine",
    "fake",
    "--speaker",
    "fake",
    "--port",
    String(sttPort),
    "--voiceprints",
    store,
    "--public-config",
    "",
    "--origin",
    ORIGIN,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let sttLog = "";
stt.stdout.on("data", (b) => (sttLog += String(b)));
await Promise.all([
  waitFor(widget, "listening", "widget server"),
  waitFor(stt, "listening on", "stt server"),
]);

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sel = (id) => `[data-testid="${id}"]`;

const browser = await launchSilent(chromium);
try {
  for (const scheme of ["light", "dark"]) {
    const from = sttLog.length;
    const log = () => sttLog.slice(from);
    const ctx = await newSilentContext(browser, {
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
    });
    await ctx.addInitScript(
      ([src, ws]) => {
        localStorage.setItem("lk:debug-widget-src", src);
        localStorage.setItem("lk:agent-local-stt", ws);
        window.__gum = 0;
        if (navigator.mediaDevices)
          navigator.mediaDevices.getUserMedia = async () => {
            window.__gum++;
            throw new DOMException("refused in QA", "NotAllowedError");
          };
      },
      [`${ORIGIN}/debug-chat.js`, `ws://localhost:${sttPort}`],
    );
    const page = await ctx.newPage();
    await page.goto(`${ORIGIN}/harness?open`);
    await page.waitForSelector("[data-debug-widget] [data-debug-chat]", { timeout: 30_000 });
    await page.waitForTimeout(400);
    await page.dblclick(sel("debug-chat-pill-min"));
    await page.waitForSelector(sel("debug-menu-voiceprint"), { timeout: 5_000 });
    await page.click(sel("debug-menu-voiceprint"));
    await page.waitForSelector(`${sel("debug-voiceprint")}[data-step="status"]`, {
      timeout: 10_000,
    });
    check(
      !(await page.$(sel("debug-voiceprint-off"))),
      `${scheme}: the panel reached the Mac (status)`,
    );
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `voiceprint-status-${scheme}.png`) });
    }
    await page.click(sel("debug-voiceprint-enrol"));
    await page.waitForSelector(sel("debug-voiceprint-consent"));
    const consent = await page.textContent(sel("debug-voiceprint-consent"));
    check(
      consent.includes("~/.config/lianki-stt/voiceprints"),
      `${scheme}: the consent card says where the print is kept`,
    );
    check(consent.includes("10–20"), `${scheme}: and how many sentences`);
    check(
      !(await page.isChecked(sel("debug-voiceprint-keep-audio"))),
      `${scheme}: keep-audio is off by default`,
    );
    check(
      (await page.evaluate(() => window.__gum)) === 0,
      `${scheme}: no microphone before the tap`,
    );
    check(
      !log().includes("enrolment started"),
      `${scheme}: no enrolment on the Mac before the tap`,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `voiceprint-consent-${scheme}.png`) });
    await page.click(sel("debug-voiceprint-agree"));
    // The stub refuses the microphone: the card says so and the Mac drops the enrolment.
    await page.waitForSelector(`${sel("debug-voiceprint")}[data-step="error"]`, {
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    check(
      log().includes("enrolment started (iphone, audio not kept)"),
      `${scheme}: the tap opened the enrolment (iphone)`,
    );
    check(
      (await page.evaluate(() => window.__gum)) >= 1,
      `${scheme}: the tap asked for the microphone`,
    );
    check(
      (await page.textContent(sel("debug-voiceprint-error"))).includes("microphone not available"),
      `${scheme}: no microphone: the card says so`,
    );
    check(
      log().includes("enrolment cancelled"),
      `${scheme}: and the Mac drops the enrolment, unsaved`,
    );
    await page.click(sel("debug-voiceprint-close"));
    // The verified mark.
    await page.evaluate(() => {
      window.__line({
        text: "这是我说的话",
        source: "stt",
        speaker: { decision: "me", score: 0.5, model: "campp", device: "iphone" },
      });
      window.__line({
        text: "电视里的声音",
        source: "stt",
        speaker: { decision: "other", score: 0.05 },
      });
    });
    await page.waitForTimeout(200);
    const marks = await page.$$eval(sel("debug-chat-voice-verified"), (els) =>
      els.map((e) => e.closest('[data-testid="debug-chat-line"]')?.textContent ?? ""),
    );
    check(
      marks.length === 1 && marks[0].includes("这是我说的话"),
      `${scheme}: the verified mark is on "me" only`,
    );
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `voiceprint-mark-${scheme}.png`) });
    await ctx.close();
  }
} finally {
  await browser.close();
  widget.kill();
  stt.kill();
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall ok");
