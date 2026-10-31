/**
 * Where each account preference lives on the device (docs/prefs-sync.md):
 * one binding per server key of lib/prefs/schema.ts. A binding reads the
 * local value, writes a server value back, and knows the default.
 *
 * Two kinds:
 * - a field of an account store (`@lianki/ui-state`, `lk:pref:<store>`):
 *   motion, swipe feel, nav pins. Applied through the store when the page has
 *   it, else into its persisted JSON;
 * - a plain localStorage key the feature already reads (`lk:words-show-all`,
 *   `lk:paper`, the chat's `lk:agent-speech-rate`, …). Kept, so the code that
 *   reads them (some of it before first paint, some in the chat widget, which
 *   cannot import the app) needs no change. Writers call `notePrefWrite()`;
 *   a remote value fires `lk:pref-applied`, which usePref and friends follow.
 *
 * Device-local keys (mic, full screen, positions, dev URLs, echo cancel) are
 * not here, so they can never be sent.
 */
import type { PrefBinding } from "@lianki/ui-state/account";
import { REGISTRY, type UiStore } from "@lianki/ui-state";
import { CATALOG_URLS, type PrefKey } from "@/lib/prefs/schema";
import { LOCALE_PICK_KEY } from "@/lib/app-locale";

type Ls = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const ls = (): Ls | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};
const getRaw = (k: string) => {
  try {
    return ls()?.getItem(k) ?? null;
  } catch {
    return null;
  }
};
const setRaw = (k: string, v: string) => {
  try {
    ls()?.setItem(k, v);
  } catch {}
};

type Codec = { decode(raw: string): unknown; encode(v: unknown): string };

/** "1" / "0" (usePref on /words). */
export const bool10: Codec = {
  decode: (r) => (r === "1" ? true : r === "0" ? false : undefined),
  encode: (v) => (v ? "1" : "0"),
};
/** Two words for on and off. */
const pair = (on: string, off: string): Codec => ({
  decode: (r) => (r === on ? true : r === off ? false : undefined),
  encode: (v) => (v ? on : off),
});
const text: Codec = { decode: (r) => r, encode: (v) => String(v) };
const num: Codec = {
  decode: (r) => (r.trim() === "" || !Number.isFinite(Number(r)) ? undefined : Number(r)),
  encode: (v) => String(v),
};
const jsonCodec: Codec = {
  decode: (r) => {
    try {
      return JSON.parse(r);
    } catch {
      return undefined;
    }
  },
  encode: (v) => JSON.stringify(v),
};

function plain(
  key: PrefKey,
  local: string,
  codec: Codec,
  fallback: unknown,
  extra?: { also?: (v: unknown) => void; read?: () => string | null },
): PrefBinding {
  return {
    key,
    fallback,
    get: () => {
      const raw = extra?.read ? extra.read() : getRaw(local);
      return raw === null ? undefined : codec.decode(raw);
    },
    set: (v) => {
      setRaw(local, codec.encode(v));
      extra?.also?.(v);
    },
  };
}

type Persisted = { state?: Record<string, unknown>; version?: number };

/** A field of an account store, `lk:pref:<store>` at `version`. */
function field(
  key: PrefKey,
  store: string,
  version: number,
  name: string,
  fallback: unknown,
  /** The store's own default that means "not chosen" (motion's "system"). */
  unset?: unknown,
): PrefBinding {
  const lsKey = `lk:pref:${store}`;
  const live = (): UiStore<Record<string, unknown>> | undefined =>
    (globalThis as unknown as Record<string, Map<string, UiStore<Record<string, unknown>>>>)[
      REGISTRY
    ]?.get(lsKey);
  return {
    key,
    fallback,
    get: () => {
      const s = live();
      let v: unknown;
      if (s) v = s.getState()[name];
      else {
        try {
          const p = JSON.parse(getRaw(lsKey) ?? "null") as Persisted | null;
          if (!p || p.version !== version) return undefined;
          v = p.state?.[name];
        } catch {
          return undefined;
        }
      }
      return v === undefined || (unset !== undefined && v === unset) ? undefined : v;
    },
    set: (v) => {
      const s = live();
      if (s) {
        if (s.version !== version) return;
        s.setState({ [name]: v });
        return;
      }
      let p: Persisted = {};
      try {
        p = (JSON.parse(getRaw(lsKey) ?? "null") as Persisted | null) ?? {};
      } catch {}
      if (p.version !== undefined && p.version !== version) return;
      setRaw(lsKey, JSON.stringify({ state: { ...p.state, [name]: v }, version }));
    },
  };
}

const COOKIE_YEAR_S = 365 * 24 * 60 * 60;

function setLocaleCookies(v: unknown) {
  try {
    for (const name of ["NEXT_LOCALE", "lang"])
      document.cookie = `${name}=${String(v)}; path=/; max-age=${COOKIE_YEAR_S}; SameSite=Lax`;
  } catch {}
}

/** Pins of the home matrix only: a site of your own cards stays on this device. */
function homePins(): PrefBinding {
  const local = "lk:home:pins";
  const all = (): string[] => {
    try {
      const v = JSON.parse(getRaw(local) ?? "null");
      return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    key: "home.pins",
    fallback: [],
    get: () => (getRaw(local) === null ? undefined : all().filter((p) => CATALOG_URLS.has(p))),
    set: (v) => {
      const mine = all().filter((p) => !CATALOG_URLS.has(p));
      setRaw(local, JSON.stringify([...(v as string[]), ...mine]));
    },
  };
}

export function prefBindings(): PrefBinding[] {
  return [
    plain("words.showAll", "lk:words-show-all", bool10, false),
    plain("words.readAloud", "lk:words-sound", pair("on", "off"), true),
    plain("words.serverVoice", "lk:words-server-voice", bool10, true),
    plain("words.speakOnSwipe", "lk:words-swipe-speak", bool10, true),
    plain("words.gradeTones", "lk:words-grade-tones", bool10, true),
    plain("words.paperScrolls", "lk:words-paper-scrolls", bool10, false),
    plain("swipe.variant", "lk:swipe-ab", text, "js"),
    field("swipe-feel.preset", "swipe-feel", 1, "preset", "light"),
    field("swipe-feel.tweaks", "swipe-feel", 1, "tweaks", {}),
    field("motion.animations", "motion", 1, "animations", "on", "system"),
    plain("ui.paper", "lk:paper", text, "b", {
      also: (v) => {
        try {
          document.documentElement.dataset.paper = String(v);
        } catch {}
      },
    }),
    plain("ui.locale", LOCALE_PICK_KEY, text, "en", { also: setLocaleCookies }),
    field("nav-pins.pinned", "nav-pins", 1, "pinned", []),
    plain("home.lang", "lk:home:lang", text, "en"),
    homePins(),
    plain("lab.immersionLangs", "lk:lab:immersion:langs", jsonCodec, []),
    plain("lab.immersionTranspose", "lk:lab:immersion:transpose", bool10, false),
    plain("chat-voice.rate", "lk:agent-speech-rate", num, 1.5),
    plain("chat-voice.out", "lk:voice-out", text, "speech"),
    // The chat reads lk:agent-chat-speak, then its old name (storage-keys.ts).
    plain("chat-voice.speak", "lk:agent-chat-speak", bool10, true, {
      read: () => getRaw("lk:agent-chat-speak") ?? getRaw("lk:debug-chat-speak"),
      also: (v) => setRaw("lk:debug-chat-speak", v ? "1" : "0"),
    }),
  ];
}
