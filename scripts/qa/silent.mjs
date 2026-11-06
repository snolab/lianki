// Silent browsers for every Lianki QA and repro script (owner, 2026-10-31: the
// Mac read words aloud in the middle of the night; 2026-11-06: "if u doesn't make
// audio at all, then u don't need to mute/unmute my Mac"). This layer is all there
// is: nothing in QA touches the Mac's mute or volume. Every Playwright launch and
// context goes through here; unit/qa-silent.test.ts fails on one that does not,
// and scripts/qa/qa-audio-free.mjs (in qa:all) proves the layer in each engine.
//
// - Always headless.
// - Chromium: --mute-audio for the whole process, and a fake capture device, so
//   no QA run can ever open the real microphone.
// - Firefox: its volume scale at zero and speech off (no QA suite uses it).
// - Every engine (WebKit has no mute flag): an init script, in all frames and
//   popups, that keeps media elements muted from birth, routes Web Audio into a
//   zero-gain node and turns off speechSynthesis. The app's own read-aloud switch
//   (lk:words-sound) is left alone: turning it off hides the voice settings the
//   suites test, and every audio output is already silent.

export const MUTE_ARGS = ["--mute-audio"];
/** A fake capture device: getUserMedia never reaches the real microphone. */
export const FAKE_MIC_ARGS = ["--use-fake-device-for-media-stream"];
export const FIREFOX_SILENT_PREFS = {
  "media.volume_scale": "0.0",
  "media.webspeech.synth.enabled": false,
};

/** Runs in every page and frame before its own scripts. */
export const SILENT_INIT = `(() => {
  try {
    const M = HTMLMediaElement;
    const P = M.prototype;
    const muted = Object.getOwnPropertyDescriptor(P, "muted");
    const volume = Object.getOwnPropertyDescriptor(P, "volume");
    const hush = (el) => { muted.set.call(el, true); volume.set.call(el, 0); return el; };
    Object.defineProperty(P, "muted", { configurable: true, get() { return muted.get.call(this); }, set() { muted.set.call(this, true); } });
    Object.defineProperty(P, "volume", { configurable: true, get() { return volume.get.call(this); }, set() { volume.set.call(this, 0); } });
    const play = P.play;
    P.play = function () { hush(this); return play.call(this); };
    // From birth, for an element that never calls play(): <audio autoplay>.
    const made = (fn) => function () { const el = fn.apply(this, arguments); if (el instanceof M) hush(el); return el; };
    Document.prototype.createElement = made(Document.prototype.createElement);
    Document.prototype.createElementNS = made(Document.prototype.createElementNS);
    if (window.Audio) window.Audio = new Proxy(window.Audio, { construct: (t, a, n) => hush(Reflect.construct(t, a, n)) });
    // Parsed or set through innerHTML: caught before it can start.
    for (const type of ["loadstart", "loadedmetadata", "canplay", "play", "playing"])
      window.addEventListener(type, (e) => { if (e.target instanceof M) hush(e.target); }, true);
    for (const el of document.querySelectorAll("audio,video")) hush(el);
    // At the parse too: Firefox replaces an iframe's first document, and an element
    // made in the old one never sends those events. The realm's prototypes stay.
    const inner = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      enumerable: inner.enumerable,
      get: inner.get,
      set(v) {
        inner.set.call(this, v);
        for (const el of this.querySelectorAll("audio,video")) hush(el);
      },
    });
  } catch {}
  try {
    const AN = window.AudioNode;
    const Dest = window.AudioDestinationNode;
    if (AN && Dest) {
      const connect = AN.prototype.connect;
      const sinks = new WeakMap();
      AN.prototype.connect = function (target, ...rest) {
        if (target instanceof Dest) {
          let g = sinks.get(target);
          if (!g) {
            g = target.context.createGain();
            g.gain.value = 0;
            connect.call(g, target);
            sinks.set(target, g);
          }
          return connect.call(this, g, ...rest);
        }
        return connect.call(this, target, ...rest);
      };
    }
  } catch {}
  try {
    // On the prototype: WebKit can hand out a new wrapper for speechSynthesis,
    // and a property set on the old one is gone (it spoke in qa-audio-free's probe).
    if (window.SpeechSynthesis) window.SpeechSynthesis.prototype.speak = () => {};
    if (window.speechSynthesis) window.speechSynthesis.speak = () => {};
  } catch {}
})();`;

const isChromium = (type) => type.name() === "chromium";
const isFirefox = (type) => type.name() === "firefox";

/** Headless whatever the caller asked, with each engine's own silencing. */
function silentOptions(type, options) {
  const o = { ...options, headless: true };
  if (isChromium(type)) o.args = [...(options.args ?? []), ...MUTE_ARGS, ...FAKE_MIC_ARGS];
  if (isFirefox(type))
    o.firefoxUserPrefs = { ...options.firefoxUserPrefs, ...FIREFOX_SILENT_PREFS };
  return o;
}

const silenced = new WeakSet();

/** browserType.launch, muted. Its contexts and pages all carry the init script. */
export async function launchSilent(type, options = {}) {
  const browser = await type.launch(silentOptions(type, options));
  if (typeof browser?.newContext !== "function") return browser;
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (o) => {
    const ctx = await newContext(o);
    await ctx.addInitScript(SILENT_INIT);
    return ctx;
  };
  browser.newPage = async (o) => (await browser.newContext(o)).newPage();
  silenced.add(browser);
  return browser;
}

/** browser.newContext, with the silencing init script. */
export async function newSilentContext(browser, options = {}) {
  const ctx = await browser.newContext(options);
  if (!silenced.has(browser)) await ctx.addInitScript(SILENT_INIT);
  return ctx;
}

/** browserType.launchPersistentContext, muted and silenced. */
export async function launchPersistentSilent(type, userDataDir, options = {}) {
  const ctx = await type.launchPersistentContext(userDataDir, silentOptions(type, options));
  await ctx.addInitScript(SILENT_INIT);
  return ctx;
}
