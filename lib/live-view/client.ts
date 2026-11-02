/**
 * Live view on the page (docs/live-view.md). The app layout hands the owner's
 * page the stored pointer (the server checked the owner and the signature);
 * `startLiveView` checks the signature again here, with WebCrypto and the
 * public keys bundled with this build, and only then publishes the sources.
 * The widget host (DebugEval) and the islands (useIslands) read them from
 * this store; on production nothing else may point them at dev JS.
 *
 * Plain JS, no React beyond one hook. Nothing here polls: one local timer
 * turns live view off when the pointer expires.
 */
import { useSyncExternalStore } from "react";
import { liveViewKeys } from "./keys";
import {
  LIVE_VIEW_COOKIE,
  type LiveViewClaim,
  unsignedOverridesAllowed,
  verifyLiveView,
} from "./rules";

export type LiveState = { on: false; note?: string } | { on: true; claim: LiveViewClaim };

const OFF: LiveState = { on: false };

export function createLiveViewStore(
  timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout> | undefined) => clearTimeout(t),
  },
) {
  let state: LiveState = OFF;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  /**
   * Bumped by every start() and stop(): a start() still awaiting its keys or
   * its verify when a newer call came in publishes nothing.
   */
  let gen = 0;
  const listeners = new Set<() => void>();
  const set = (s: LiveState) => {
    state = s;
    for (const l of listeners) l();
  };
  return {
    get: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /**
     * Verify `token` and turn live view on with it; anything wrong leaves it
     * off, with the reason in `note`. `keys` and `now` are for tests.
     */
    async start(
      token: string | null | undefined,
      o: { keys?: CryptoKey[]; now?: number; allowLocal?: boolean } = {},
    ): Promise<LiveState> {
      const mine = ++gen;
      timers.clearTimeout(expiry);
      if (!token) {
        set(OFF);
        return state;
      }
      const now = o.now ?? Date.now();
      const keys = o.keys ?? (await liveViewKeys());
      if (mine !== gen) return state;
      const v = await verifyLiveView(token, keys, {
        op: "on",
        now,
        allowLocal: o.allowLocal ?? unsignedOverridesAllowed(),
      });
      // Stopped, or superseded, while verifying: leave the newer state alone.
      if (mine !== gen) return state;
      if (!v.ok) {
        set({ on: false, note: `live view refused: ${v.error}` });
        return state;
      }
      const left = v.claim.exp * 1000 - now;
      if (left < 2 ** 31 - 1)
        expiry = timers.setTimeout(() => set({ on: false, note: "expired" }), left);
      set({ on: true, claim: v.claim });
      return state;
    },
    stop() {
      gen++;
      timers.clearTimeout(expiry);
      set(OFF);
    },
  };
}

export type LiveViewStore = ReturnType<typeof createLiveViewStore>;

/**
 * The page's one store, shared by the boot component, the widget host and the
 * islands. Module-local on purpose, never on globalThis: no other script on
 * the page can plant a store that says "on" with a source of its choosing.
 */
export const liveView: LiveViewStore = createLiveViewStore();

export function useLiveView(store: LiveViewStore = liveView): LiveState {
  return useSyncExternalStore(store.subscribe, store.get, () => OFF);
}

/** This device's switch: does the owner want live view here? (A hint only; the server decides.) */
export function liveWanted(
  cookie: string = typeof document === "undefined" ? "" : document.cookie,
) {
  return cookie.split(/;\s*/).includes(`${LIVE_VIEW_COOKIE}=1`);
}

/** Flip this device's switch (a year; the pointer itself lasts 12 h at most). */
export function setLiveWanted(on: boolean) {
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = on
    ? `${LIVE_VIEW_COOKIE}=1; path=/; max-age=31536000; samesite=lax${secure}`
    : `${LIVE_VIEW_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
}

/**
 * Where the widget host may load the widget from: the verified pointer's
 * widget; else `undefined` (= the host reads its old localStorage key) where
 * unsigned overrides are allowed (dev builds, localhost); else `null` (= none).
 */
export function widgetSource(s: LiveState, unsigned = unsignedOverridesAllowed()) {
  if (s.on) return s.claim.widget ?? (unsigned ? undefined : null);
  return unsigned ? undefined : null;
}
