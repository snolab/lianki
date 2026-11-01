#!/usr/bin/env node
/**
 * Browser checks for the voiceprint panel (packages/debug-chat/src/VoiceprintPanel.tsx;
 * docs/local-stt.md, "Voiceprint") on the local /harness page, against the
 * real local STT server with no models (`server.py --engine fake --speaker
 * fake`) and a voiceprint folder in a temp dir. Silent (scripts/qa/silent.mjs),
 * and getUserMedia is stubbed (counted, then refused): nothing is recorded.
 *
 * lianki.com's /api/dev/voiceprint-ticket is played by this script (a test
 * Ed25519 key the server is given), and navigator.credentials.get is stubbed
 * (counted): it stands for the owner's Face ID / Touch ID prompt.
 *
 *   - the menu's Voiceprint opens the panel; status with a status ticket
 *   - Enrol shows the consent card (the path, keep-audio off); nothing
 *     reaches the passkey, the microphone or the Mac before a real tap
 *   - a synthetic click (element.click(), isTrusted false) does nothing
 *   - the real tap asks for the passkey, then the Mac opens the enrolment;
 *     a refused mic drops it there
 *   - a voice line tagged "me" (verified by the hub) shows the mark; "other" does not
 *
 *   node scripts/dev/voiceprint-qa.mjs [--shots <dir>]   (light/dark at 390 px)
 */
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    proc.stdout.on("data", (b) => {
      buf += String(b);
      if (buf.includes(text)) {
        clearTimeout(t);
        resolve(buf);
      }
    });
    proc.on("exit", (c) => reject(new Error(`${what} exited (${c}): ${buf}`)));
  });

// lianki.com's ticket key, for the test only.
const b64u = (b) => Buffer.from(b).toString("base64url");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pubRaw = publicKey.export({ format: "jwk" }).x;
const ticket = (fields) => {
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(
    JSON.stringify({ jti: b64u(randomBytes(12)), iat: now, exp: now + 60, ...fields }),
  );
  return `${body}.${b64u(sign(null, Buffer.from(body), privateKey))}`;
};

const port = await freePort();
const sttPort = await freePort();
const ORIGIN = `http://localhost:${port}`;
const tmp = mkdtempSync(join(tmpdir(), "lk-voiceprint-qa-"));
const store = join(tmp, "voiceprints");
const pubFile = join(tmp, "ticket.pub");
writeFileSync(pubFile, `${pubRaw}\n`, { mode: 0o600 });
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
    "--voiceprint-pubkey",
    pubFile,
    "--attest-key",
    "",
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
const asked = [];

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
    // lianki.com's ticket route, as the owner's session would get it.
    await ctx.route("**/api/dev/voiceprint-ticket", async (route) => {
      const b = JSON.parse(route.request().postData() || "{}");
      asked.push(`${b.op}:${b.step ?? ""}`);
      const json = (o) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
      if (b.op === "status")
        return json({
          ticket: ticket({ aud: "lianki-voiceprint", op: "status", device: "*", uv: false }),
        });
      if (b.step === "options")
        return json({
          token: "t",
          options: {
            challenge: b64u(randomBytes(32)),
            rpId: "localhost",
            userVerification: "required",
            allowCredentials: [{ id: b64u(Buffer.from("cred")), type: "public-key" }],
          },
        });
      return json({
        ticket: ticket({
          aud: "lianki-voiceprint",
          op: b.op,
          device: b.device,
          uv: true,
          ...(b.op === "enrol" ? { keepAudio: b.keepAudio === true } : {}),
        }),
      });
    });
    await ctx.addInitScript(
      ([src, ws]) => {
        localStorage.setItem("lk:debug-widget-src", src);
        localStorage.setItem("lk:agent-local-stt", ws);
        window.__gum = 0;
        window.__passkey = 0;
        if (navigator.mediaDevices)
          navigator.mediaDevices.getUserMedia = async () => {
            window.__gum++;
            throw new DOMException("refused in QA", "NotAllowedError");
          };
        // The owner's Face ID: counted, answered with a dummy assertion (this script's route checks nothing).
        const b = (s) => new TextEncoder().encode(s).buffer;
        navigator.credentials.get = async () => {
          window.__passkey++;
          return {
            id: "cred",
            rawId: b("cred"),
            type: "public-key",
            response: {
              clientDataJSON: b("{}"),
              authenticatorData: b("a"),
              signature: b("s"),
              userHandle: null,
            },
            getClientExtensionResults: () => ({}),
          };
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
      `${scheme}: the panel reached the Mac with a status ticket`,
    );
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `voiceprint-status-${scheme}.png`) });
    }
    // A synthetic click (eval, a script): nothing.
    await page.evaluate((s) => document.querySelector(s)?.click(), sel("debug-voiceprint-enrol"));
    await page.waitForTimeout(200);
    check(
      !(await page.$(sel("debug-voiceprint-consent"))),
      `${scheme}: a synthetic click on Enrol does nothing`,
    );
    await page.click(sel("debug-voiceprint-enrol"));
    await page.waitForSelector(sel("debug-voiceprint-consent"));
    const consent = await page.textContent(sel("debug-voiceprint-consent"));
    check(
      consent.includes("~/.config/lianki-stt/voiceprints"),
      `${scheme}: the consent card says where the print is kept`,
    );
    check(
      !(await page.isChecked(sel("debug-voiceprint-keep-audio"))),
      `${scheme}: keep-audio is off by default`,
    );
    await page.evaluate((s) => document.querySelector(s)?.click(), sel("debug-voiceprint-agree"));
    await page.waitForTimeout(300);
    check(
      (await page.evaluate(() => window.__passkey)) === 0,
      `${scheme}: a synthetic click on Agree asks no passkey`,
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
    await page.waitForSelector(`${sel("debug-voiceprint")}[data-step="error"]`, {
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    check(
      (await page.evaluate(() => window.__passkey)) === 1,
      `${scheme}: the tap asked for the passkey`,
    );
    check(
      log().includes("enrolment started (iphone, audio not kept)"),
      `${scheme}: then the Mac opened the enrolment (iphone)`,
    );
    check(
      (await page.evaluate(() => window.__gum)) >= 1,
      `${scheme}: and asked for the microphone`,
    );
    check(
      log().includes("enrolment cancelled"),
      `${scheme}: a refused mic drops it on the Mac, unsaved`,
    );
    await page.click(sel("debug-voiceprint-close"));
    // The verified mark (a tag the hub stored after checking the Mac's proof).
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
    await ctx.close();
  }
  check(
    asked.includes("enrol:options") && asked.includes("enrol:verify"),
    "the ticket came through options and verify",
  );
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
