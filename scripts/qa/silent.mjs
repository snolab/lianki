// Silent browsers for every Lianki QA and repro script (owner, 2026-10-31: the
// Mac read words aloud in the middle of the night). Every Playwright launch
// and context goes through here; unit/qa-silent.test.ts fails on one that
// does not.
//
// - Chromium: --mute-audio.
// - Every engine (WebKit has no mute flag): an init script that keeps media
//   elements muted, routes Web Audio into a zero-gain node, turns off
//   speechSynthesis. The app's own read-aloud switch (lk:words-sound) is left
//   alone: turning it off hides the voice settings the suites test, and every
//   audio output is already silent.
//
// The Mac's output is muted too while qa:all runs (scripts/qa/with-muted-mac.sh).

export const MUTE_ARGS = ["--mute-audio"];

/** Runs in every page before its own scripts. */
export const SILENT_INIT = `(() => {
  try {
    const P = HTMLMediaElement.prototype;
    const muted = Object.getOwnPropertyDescriptor(P, "muted");
    const volume = Object.getOwnPropertyDescriptor(P, "volume");
    Object.defineProperty(P, "muted", { configurable: true, get() { return muted.get.call(this); }, set() { muted.set.call(this, true); } });
    Object.defineProperty(P, "volume", { configurable: true, get() { return volume.get.call(this); }, set() { volume.set.call(this, 0); } });
    const play = P.play;
    P.play = function () { muted.set.call(this, true); volume.set.call(this, 0); return play.call(this); };
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
    if (window.speechSynthesis) window.speechSynthesis.speak = () => {};
  } catch {}
})();`;

const isChromium = (type) => type.name() === "chromium";

/** browserType.launch, muted. */
export function launchSilent(type, options = {}) {
  return type.launch(
    isChromium(type) ? { ...options, args: [...(options.args ?? []), ...MUTE_ARGS] } : options,
  );
}

/** browser.newContext, with the silencing init script. */
export async function newSilentContext(browser, options = {}) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(SILENT_INIT);
  return ctx;
}

/** browserType.launchPersistentContext, muted and silenced. */
export async function launchPersistentSilent(type, userDataDir, options = {}) {
  const ctx = await type.launchPersistentContext(
    userDataDir,
    isChromium(type) ? { ...options, args: [...(options.args ?? []), ...MUTE_ARGS] } : options,
  );
  await ctx.addInitScript(SILENT_INIT);
  return ctx;
}
