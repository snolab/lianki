#!/usr/bin/env bun
// QA has no safety net on the Mac's sound (owner, 2026-11-06: "if u doesn't make
// audio at all, then u don't need to mute/unmute my Mac"), so this proves the
// layer in scripts/qa/silent.mjs holds, in each engine QA uses and everywhere a
// page can make sound: frames of every kind, popups, new Audio(), <audio autoplay>,
// Web Audio, audio worklets, speechSynthesis, workers.
//
// This cannot itself make a sound, even if the layer is broken:
// - Web Audio is rendered in OfflineAudioContexts: into a buffer, with no audio
//   device behind them. A real AudioContext here is given no source at all.
// - The media elements' file is all zero samples.
// - speak() is never called, only inspected.
// A control context without the layer shows the checks can fail.
//
// What this does not observe is the speaker: Chromium's --mute-audio is a process
// flag this can only see passed (unit/qa-silent.test.ts).
import { chromium, firefox, webkit } from "playwright";
import { existsSync } from "node:fs";
import { launchSilent, newSilentContext } from "./silent.mjs";

let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) ok = false;
};

/** RIFF WAV, 8 kHz mono 16-bit: a tenth of a second of zeros. */
function silentWav() {
  const samples = 800;
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}
const WAV_URL = "https://probe.test/silence.wav";

/** Runs inside a page or frame. `win` is the realm under test. Makes no sound. */
async function probeRealm(win, url) {
  const r = {};
  const a = new win.Audio(url);
  a.muted = false;
  a.volume = 1;
  r.newAudio = { muted: a.muted, volume: a.volume };
  const d = win.document;
  const el = d.createElement("audio");
  r.createElement = { muted: el.muted };
  const host = d.createElement("div");
  host.innerHTML = `<audio autoplay src="${url}"></audio>`;
  d.documentElement.appendChild(host);
  const auto = host.firstChild;
  await new Promise((ok) => {
    let n = 0;
    const t = win.setInterval(() => {
      if (auto.muted || ++n > 25) {
        win.clearInterval(t);
        ok();
      }
    }, 20);
  });
  r.autoplayAttr = { muted: auto.muted };
  auto.pause();
  host.remove();

  const render = async (build) => {
    const off = new win.OfflineAudioContext(1, 4410, 44100);
    await build(off);
    const buf = await off.startRendering();
    return buf.getChannelData(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  };
  r.oscillatorPeak = await render((off) => {
    const o = off.createOscillator();
    o.connect(off.destination);
    o.start();
  });
  r.throughGainPeak = await render((off) => {
    const o = off.createOscillator();
    const g = off.createGain();
    g.gain.value = 1;
    o.connect(g);
    g.connect(off.destination);
    o.start();
  });
  r.bufferSourcePeak = await render((off) => {
    const b = off.createBuffer(1, 4410, 44100);
    b.getChannelData(0).fill(0.5);
    const s = off.createBufferSource();
    s.buffer = b;
    s.connect(off.destination);
    s.start();
  });
  try {
    r.workletPeak = await render(async (off) => {
      const code = `registerProcessor("loud", class extends AudioWorkletProcessor {
        process(_i, o) { o[0][0].fill(0.5); return true; }
      });`;
      const url2 = win.URL.createObjectURL(new win.Blob([code], { type: "text/javascript" }));
      await off.audioWorklet.addModule(url2);
      new win.AudioWorkletNode(off, "loud").connect(off.destination);
    });
  } catch (e) {
    r.workletPeak = `unavailable: ${String(e).slice(0, 60)}`;
  }
  // A real context: no source is ever connected to it, only a gain of zero.
  const AC = win.AudioContext ?? win.webkitAudioContext;
  if (AC) {
    const ctx = new AC();
    // On the prototype: a property set on this wrapper may not be on the one
    // destination.context hands back.
    const proto = win.BaseAudioContext?.prototype ?? win.Object.getPrototypeOf(ctx);
    const createGain = proto.createGain;
    let gains = 0;
    proto.createGain = function () {
      gains++;
      return createGain.call(this);
    };
    const z = createGain.call(ctx);
    z.gain.value = 0;
    z.connect(ctx.destination);
    proto.createGain = createGain;
    // Two in a WebKit popup, where the init script runs twice: silent all the same.
    r.realContextRouted = gains >= 1;
    await ctx.close();
  }
  const s = win.speechSynthesis;
  if (s) {
    const native = /\[native code\]/.test(win.Function.prototype.toString.call(s.speak));
    const proto = win.Object.getPrototypeOf(s).speak;
    r.speak = {
      instanceReplaced: !native,
      protoReplaced: !/\[native code\]/.test(win.Function.prototype.toString.call(proto)),
    };
  } else r.speak = { instanceReplaced: true, protoReplaced: true, absent: true };
  return r;
}

const silent = (r, withWorklet = true) => {
  const bad = [];
  if (!r.newAudio.muted || r.newAudio.volume !== 0) bad.push("new Audio()");
  if (!r.createElement.muted) bad.push("createElement");
  if (!r.autoplayAttr.muted) bad.push("<audio autoplay>");
  if (r.oscillatorPeak !== 0) bad.push("oscillator");
  if (r.throughGainPeak !== 0) bad.push("through a gain");
  if (r.bufferSourcePeak !== 0) bad.push("buffer source");
  if (withWorklet && typeof r.workletPeak === "number" && r.workletPeak !== 0) bad.push("worklet");
  if (r.realContextRouted === false) bad.push("real AudioContext");
  if (!r.speak.instanceReplaced || !r.speak.protoReplaced) bad.push("speechSynthesis");
  return bad;
};

const PAGE = `<!doctype html><title>probe</title>
<iframe id="srcdoc" srcdoc="<!doctype html><p>x"></iframe>
<iframe id="other" src="https://other.test/frame"></iframe>
<iframe id="data" src="data:text/html,<!doctype html><p>x"></iframe>`;

async function route(ctx) {
  await ctx.route("https://probe.test/**", (r) =>
    r.request().url().endsWith(".wav")
      ? r.fulfill({ contentType: "audio/wav", body: silentWav() })
      : r.fulfill({ contentType: "text/html", body: PAGE }),
  );
  await ctx.route("https://other.test/**", (r) =>
    r.request().url().endsWith(".wav")
      ? r.fulfill({
          contentType: "audio/wav",
          body: silentWav(),
          headers: { "access-control-allow-origin": "*" },
        })
      : r.fulfill({ contentType: "text/html", body: "<!doctype html><p>other" }),
  );
}

const frameProbe = (frame) => frame.evaluate(`(${probeRealm})(window, ${JSON.stringify(WAV_URL)})`);

async function runEngine(name, type) {
  console.log(`— ${name}`);
  const browser = await launchSilent(type);
  try {
    const ctx = await newSilentContext(browser);
    await route(ctx);
    const page = await ctx.newPage();
    await page.goto("https://probe.test/");

    const top = await frameProbe(page.mainFrame());
    check(silent(top).length === 0, `${name}: top page silent ${show(top, silent(top))}`);

    for (const frame of page.frames().filter((f) => f !== page.mainFrame())) {
      const label = frame.url().slice(0, 30) || "(blank)";
      const r = await frameProbe(frame).catch((e) => ({ error: String(e).slice(0, 120) }));
      if (r.error) {
        check(false, `${name}: frame ${label}: ${r.error}`);
        continue;
      }
      check(silent(r).length === 0, `${name}: frame ${label} silent ${show(r, silent(r))}`);
    }

    // An iframe used in the same tick it is made: its first document, before any load.
    const sync = await page.evaluate(`(async () => {
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      return (${probeRealm})(f.contentWindow, ${JSON.stringify(WAV_URL)});
    })()`);
    check(
      silent(sync).length === 0,
      `${name}: iframe used at once silent ${show(sync, silent(sync))}`,
    );

    const blob = await page.evaluate(`(async () => {
      const f = document.createElement("iframe");
      f.src = URL.createObjectURL(new Blob(["<!doctype html><p>b"], { type: "text/html" }));
      await new Promise((ok) => { f.onload = ok; document.body.appendChild(f); });
      return (${probeRealm})(f.contentWindow, ${JSON.stringify(WAV_URL)});
    })()`);
    check(silent(blob).length === 0, `${name}: blob: iframe silent ${show(blob, silent(blob))}`);

    const [popup] = await Promise.all([
      ctx.waitForEvent("page"),
      page.evaluate(`void window.open("https://probe.test/popup")`),
    ]);
    await popup.waitForLoadState();
    const pop = await frameProbe(popup.mainFrame());
    check(silent(pop).length === 0, `${name}: popup silent ${show(pop, silent(pop))}`);
    await popup.close();

    // A worker has no way to make a sound: none of these exist in it.
    const inWorker = await page.evaluate(`new Promise((ok, no) => {
      const code = 'postMessage(["AudioContext","webkitAudioContext","OfflineAudioContext","Audio","speechSynthesis","HTMLMediaElement"].filter((k) => k in self))';
      const w = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      w.onmessage = (e) => { w.terminate(); ok(e.data); };
      w.onerror = (e) => no(new Error(e.message));
    })`);
    check(
      inWorker.length === 0,
      `${name}: a worker has no audio API (${inWorker.join(", ") || "none"})`,
    );

    // browser.newPage() skips newSilentContext: the launch must cover it as well.
    const direct = await browser.newPage();
    await route(direct.context());
    await direct.goto("https://probe.test/");
    const d = await frameProbe(direct.mainFrame());
    check(silent(d).length === 0, `${name}: browser.newPage() silent ${show(d, silent(d))}`);
    await direct.context().close();
    await ctx.close();
  } finally {
    await browser.close();
  }

  // The control, on an unpatched launch: it renders into a buffer and never plays.
  const bare = await type.launch();
  try {
    const ctx = await bare.newContext();
    await route(ctx);
    const page = await ctx.newPage();
    await page.goto("https://probe.test/");
    const peak0 = await page.evaluate(`(async () => {
      const off = new OfflineAudioContext(1, 4410, 44100);
      const o = off.createOscillator();
      o.connect(off.destination);
      o.start();
      const buf = await off.startRendering();
      return buf.getChannelData(0).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    })()`);
    check(
      peak0 > 0,
      `${name}: control without the layer does render a signal (peak ${peak0.toFixed(3)})`,
    );
  } finally {
    await bare.close();
  }
}

const show = (r, bad) => (bad.length ? `— leaks: ${bad.join(", ")} ${JSON.stringify(r)}` : "");

for (const [name, type] of [
  ["chromium", chromium],
  ["webkit", webkit],
  ["firefox", firefox],
]) {
  // QA itself runs Chromium and WebKit. Firefox is checked where it is installed.
  if (name === "firefox" && !existsSync(type.executablePath())) {
    console.log("— firefox: not installed, skipped (no QA suite launches it)");
    continue;
  }
  await runEngine(name, type);
}

console.log(ok ? "\n=== audio-free layer holds ===" : "\n=== audio-free layer has gaps ===");
process.exit(ok ? 0 : 1);
