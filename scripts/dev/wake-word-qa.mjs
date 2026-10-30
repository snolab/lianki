#!/usr/bin/env node
/**
 * The "Linky" gate end to end in Chromium (docs/wake-word.md), on the local
 * /harness page: the real Silero VAD, the real WASM spotter (downloaded from
 * jsDelivr and Hugging Face, then kept in the Cache API) and the real mic
 * session. The microphone is Chromium's fake capture device fed from a WAV
 * file, so nothing is recorded and nothing is played.
 *
 *   node scripts/dev/wake-word-qa.mjs --clip <wav with "Linky, …"> [--negative <wav without it>] [--save sent.wav]
 *
 * Checks: the mic on, the agent's {type: "wake", mode: "passive"} (here
 * `__lkMic.wake("passive")`) makes it passive (data-wake, the "Linky?" badge)
 * and loads the spotter; an utterance without "Linky" is dropped on the
 * device (no STT request); one with it wakes the mic (back to active) and
 * only the words after the keyword are sent to /api/debug/stt (stubbed).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i === -1 ? undefined : argv[i + 1];
};
const CLIP = arg("clip");
const NEG = arg("negative");
/** `--save <file.wav>`: write what was sent to STT, to check where the cut fell. */
const SAVE = arg("save");
if (!CLIP) {
  console.error("usage: node scripts/dev/wake-word-qa.mjs --clip <wav> [--negative <wav>]");
  process.exit(2);
}

const port = await new Promise((ok, no) => {
  const s = createServer();
  s.on("error", no);
  s.listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});
const ORIGIN = `http://localhost:${port}`;
const server = spawn(
  "bun",
  ["scripts/dev/debug-widget-server.ts", "--port", String(port), "--no-tunnel"],
  { stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((ok, no) => {
  const t = setTimeout(() => no(new Error("widget server did not start in 60 s")), 60_000);
  server.stdout.on("data", (b) => {
    if (String(b).includes("listening")) {
      clearTimeout(t);
      ok();
    }
  });
});

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

/** One browser per clip: Chromium's fake mic plays one file, looping. */
async function run(clip, expectWake) {
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${resolve(clip)}%noloop`,
      "--autoplay-policy=no-user-gesture-required",
      "--mute-audio",
    ],
  });
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["microphone"], { origin: ORIGIN });
  const page = await ctx.newPage();
  const stt = [];
  await page.route("**/api/debug/stt**", async (r) => {
    const body = r.request().postDataBuffer();
    stt.push(body?.length ?? 0);
    if (SAVE && body) writeFileSync(SAVE, body);
    await r.fulfill({ json: { text: "what's next", model: "stub", ms: 1 } });
  });
  await page.goto(`${ORIGIN}/harness?open`);
  await page.evaluate((src) => {
    // Both names: the host reads lk:agent-widget-src first (storage-keys.ts).
    localStorage.setItem("lk:agent-widget-src", src);
    localStorage.setItem("lk:debug-widget-src", src);
  }, `${ORIGIN}/debug-chat.js`);
  await page.goto(`${ORIGIN}/harness?open`);
  const mic = page.getByTestId("debug-chat-mic");
  await mic.waitFor();
  // Passive before the clip's speech starts (it begins after 3 s of silence).
  await mic.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="debug-chat-mic"]')?.dataset.state === "listening",
    null,
    { timeout: 60_000 },
  );
  await page.evaluate(() => globalThis.__lkMic.wake("passive"));
  check((await mic.getAttribute("data-wake")) === "passive", `${clip}: the agent made it passive`);
  check(await page.getByTestId("debug-chat-mic-wake").isVisible(), "the Linky? badge shows");
  const log = () =>
    page.evaluate(() => (globalThis.__devLog ?? []).filter((e) => String(e.ev).startsWith("wake")));
  await page.waitForFunction(
    () => (globalThis.__devLog ?? []).some((e) => e.ev === "wake-kws"),
    null,
    { timeout: 120_000 },
  );
  const kws = (await log()).find((e) => e.ev === "wake-kws");
  check(
    kws?.ok === true,
    `the spotter loaded (${kws?.ms} ms, downloaded: ${kws?.downloaded}${kws?.error ? `, ${kws.error}` : ""})`,
  );
  await page.waitForFunction(
    () => (globalThis.__devLog ?? []).some((e) => e.ev === "wake-spot"),
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(1500);
  const spots = (await log()).filter((e) => e.ev === "wake-spot");
  console.log("     ", JSON.stringify(spots));
  if (expectWake) {
    check(
      spots.some((e) => e.hit),
      '"Linky" was spotted',
    );
    check((await mic.getAttribute("data-wake")) === "active", "and the mic is active again");
    check(
      stt.length === 1,
      `one STT request, with the words after "Linky" only (${stt.join(", ")} bytes)`,
    );
  } else {
    check(
      spots.every((e) => !e.hit),
      "no wake word spotted",
    );
    check((await mic.getAttribute("data-wake")) === "passive", "still passive");
    check(stt.length === 0, "nothing sent to STT");
  }
  // A reload: the spotter starts from the Cache API, with no download.
  await page.reload();
  await mic.waitFor();
  // The tab had the mic on, so it resumes by itself (mic-session.ts); else a tap.
  await page.waitForTimeout(2000);
  if ((await mic.getAttribute("data-state")) === "off") await mic.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="debug-chat-mic"]')?.dataset.state === "listening",
    null,
    { timeout: 60_000 },
  );
  await page.evaluate(() => globalThis.__lkMic.wake("passive"));
  await page.waitForFunction(
    () => (globalThis.__devLog ?? []).some((e) => e.ev === "wake-kws"),
    null,
    { timeout: 60_000 },
  );
  const again = (await log()).find((e) => e.ev === "wake-kws");
  check(
    again?.ok === true && again.downloaded === false,
    `after a reload it loads from the Cache API (${again?.ms} ms, downloaded: ${again?.downloaded})`,
  );
  await browser.close();
}

try {
  await run(CLIP, true);
  if (NEG) await run(NEG, false);
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
