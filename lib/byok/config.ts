// Bring your own AI (docs/byok.md): what is kept, where, and the rules on it.
//
// Two parts, kept apart on purpose:
//
// - **The backend** (`ByokBackend`: provider, base URL, model) is not secret.
//   It is the shape both modes share: browser-only today, the managed mode
//   (the server holds the key) later. When the user ticks 「同步到我的账号」
//   it is also written to `lk:byok-backend`, the account preference
//   `byok.backend` (docs/prefs-sync.md), so it follows them to other devices.
//   The server only stores it; it never fetches the URL.
// - **The key** stays in `lk:byok` on this device only. It is never synced,
//   never stored by Lianki, never logged, and sent to Lianki only in transit
//   when the user ticks the relay for an allowlisted provider (docs/byok.md,
//   "The relay"). `lk:byok` is not a prefs-sync binding
//   (unit/byok.test.ts pins that), and "remove" deletes the whole record.
//
// The privacy notice's acknowledgement (`lk:byok-ack`) is per device and
// carries the notice's version: a changed notice asks again.

import { BYOK_PRESETS, MODEL_RE, presetOf, type ByokPreset } from "./presets";
import { checkBackend } from "./proxy-guard";

export { MODEL_RE };

export const BYOK_KEY = "lk:byok";
export const BYOK_BACKEND_KEY = "lk:byok-backend";
export const BYOK_ACK_KEY = "lk:byok-ack";
/** Fired on window after any BYOK record changed in this tab. */
export const BYOK_EVENT = "lk:byok-change";

/** Bump when the privacy notice's meaning changes: everyone is asked again. */
export const BYOK_NOTICE_VERSION = 2;

/** Where the key is kept. Only "device" exists; "account" (managed) waits for the owner. */
export type ByokMode = "device";

/** The provider and backend: not secret, shared by both modes. */
export interface ByokBackend {
  provider: string;
  baseUrl: string;
  model: string;
  /**
   * 「经 Lianki 转发（不保存）」: calls go through Lianki's relay
   * (`/api/byok/proxy`) instead of straight from the browser. Only for a
   * preset on the relay's allowlist (`relay` in presets.ts), at exactly its
   * host and path; never for a custom backend.
   */
  relay?: boolean;
}

/** This device's record (`lk:byok`). */
export interface ByokDevice {
  v: 1;
  mode: ByokMode;
  enabled: boolean;
  backend: ByokBackend;
  apiKey: string;
}

/** What a feature calls with: a usable backend and its key. */
export interface ByokActive {
  backend: ByokBackend;
  apiKey: string;
  preset: ByokPreset;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function deviceStorage(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// ── URL rules ─────────────────────────────────────────────────────────────

/** Lianki's own hosts: never a backend, whatever the user types (the relay is its own path). */
const OURS = /(^|\.)lianki\.com$/i;
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; error: "invalid" | "scheme" | "credentials" | "ours" };

/**
 * A base URL a browser may send a key to: https to any host, or http to this
 * computer only (localhost, 127.0.0.1, [::1] — Ollama and other local
 * servers). Never Lianki's own hosts or the page's own origin, never with a
 * user:password part, query or fragment. Returned without a trailing slash.
 */
export function checkBaseUrl(raw: string, pageHost?: string | null): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (u.username || u.password) return { ok: false, error: "credentials" };
  if (u.search || u.hash) return { ok: false, error: "invalid" };
  const host = u.hostname.toLowerCase();
  if (u.protocol === "http:") {
    if (!LOCAL.has(host)) return { ok: false, error: "scheme" };
  } else if (u.protocol !== "https:") return { ok: false, error: "scheme" };
  if (OURS.test(host) || (pageHost && u.host.toLowerCase() === pageHost.toLowerCase()))
    return { ok: false, error: "ours" };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, "") };
}

/** The backend as it may be stored or synced; null when any part is off. */
export function cleanBackend(v: unknown): ByokBackend | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (typeof b.provider !== "string" || !presetOf(b.provider)) return null;
  if (typeof b.baseUrl !== "string" || b.baseUrl.length > 300) return null;
  if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return null;
  const u = checkBaseUrl(b.baseUrl);
  if (!u.ok) return null;
  const relay = b.relay === true && relayable(b.provider, u.url);
  return { provider: b.provider, baseUrl: u.url, model: b.model, ...(relay ? { relay } : {}) };
}

/** May this provider at this base URL go through Lianki's relay (the allowlist)? */
export function relayable(provider: string, baseUrl: string): boolean {
  return checkBackend(provider, baseUrl).ok;
}

// ── Storage ───────────────────────────────────────────────────────────────

function readJson(s: Store | null, k: string): unknown {
  try {
    const raw = s?.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function changed() {
  try {
    globalThis.dispatchEvent?.(new Event(BYOK_EVENT));
  } catch {}
}

export function emptyDevice(provider = BYOK_PRESETS[0].id): ByokDevice {
  const p = presetOf(provider) ?? BYOK_PRESETS[0];
  return {
    v: 1,
    mode: "device",
    enabled: false,
    backend: { provider: p.id, baseUrl: p.baseUrl, model: p.model },
    apiKey: "",
  };
}

export function loadDevice(s: Store | null = deviceStorage()): ByokDevice | null {
  const v = readJson(s, BYOK_KEY) as Partial<ByokDevice> | null;
  if (!v || v.v !== 1 || !v.backend) return null;
  const p = presetOf(v.backend.provider);
  if (!p) return null;
  return {
    v: 1,
    mode: "device",
    enabled: v.enabled === true,
    backend: {
      provider: p.id,
      baseUrl: typeof v.backend.baseUrl === "string" ? v.backend.baseUrl : p.baseUrl,
      model: typeof v.backend.model === "string" ? v.backend.model : p.model,
      ...(v.backend.relay === true && p.relay ? { relay: true } : {}),
    },
    apiKey: typeof v.apiKey === "string" ? v.apiKey : "",
  };
}

export function saveDevice(d: ByokDevice, s: Store | null = deviceStorage()) {
  try {
    s?.setItem(BYOK_KEY, JSON.stringify(d));
  } catch {}
  changed();
}

/** "Remove": the key and this device's settings are gone; nothing is left to send. */
export function removeDevice(s: Store | null = deviceStorage()) {
  try {
    s?.removeItem(BYOK_KEY);
  } catch {}
  changed();
}

/** The backend synced from the account (`byok.backend`), or null when sync is off. */
export function loadSyncedBackend(s: Store | null = deviceStorage()): ByokBackend | null {
  return cleanBackend(readJson(s, BYOK_BACKEND_KEY));
}

/** Tick (a backend) or untick (null) 「同步到我的账号」; prefs-sync pushes it. */
export function saveSyncedBackend(b: ByokBackend | null, s: Store | null = deviceStorage()) {
  const v = b ? cleanBackend(b) : null;
  try {
    s?.setItem(BYOK_BACKEND_KEY, JSON.stringify(v));
  } catch {}
  changed();
}

// ── The notice ────────────────────────────────────────────────────────────

export function hasAck(s: Store | null = deviceStorage(), version = BYOK_NOTICE_VERSION) {
  const v = readJson(s, BYOK_ACK_KEY) as { v?: unknown } | null;
  return v?.v === version;
}

export function saveAck(s: Store | null = deviceStorage(), version = BYOK_NOTICE_VERSION) {
  try {
    s?.setItem(BYOK_ACK_KEY, JSON.stringify({ v: version, at: Date.now() }));
  } catch {}
  changed();
}

/**
 * Turn BYOK on or off. On needs the current notice acknowledged first: the
 * switch never turns on without 「我明白」.
 */
export function withEnabled(
  d: ByokDevice,
  on: boolean,
  acked: boolean,
): { ok: true; device: ByokDevice } | { ok: false; reason: "ack" } {
  if (on && !acked) return { ok: false, reason: "ack" };
  return { ok: true, device: { ...d, enabled: on } };
}

// ── What a feature uses ───────────────────────────────────────────────────

/** Why a record is not usable yet (the settings say which field). */
export type ByokGap = "url" | "model" | "key" | "server-only" | "relay" | null;

export function gapOf(b: ByokBackend, apiKey: string, pageHost?: string | null): ByokGap {
  const p = presetOf(b.provider);
  if (!p) return "url";
  if (b.relay) {
    // Relayed: only an allowlisted provider at exactly its allowlisted address.
    if (!checkBaseUrl(b.baseUrl, pageHost).ok || !relayable(b.provider, b.baseUrl)) return "relay";
  } else {
    if (!p.browser) return "server-only";
    if (!checkBaseUrl(b.baseUrl, pageHost).ok) return "url";
  }
  // The key first: the model is chosen from the list the key opens.
  if (!apiKey.trim() && !p.keyless) return "key";
  if (!MODEL_RE.test(b.model)) return "model";
  return null;
}

/**
 * The backend a browser feature should call now, or null: BYOK is on, its
 * notice acknowledged, and the record complete. The synced backend, when
 * there is one, wins over this device's own.
 */
export function activeByok(
  s: Store | null = deviceStorage(),
  pageHost: string | null = typeof location === "undefined" ? null : location.host,
): ByokActive | null {
  const d = loadDevice(s);
  if (!d?.enabled || !hasAck(s)) return null;
  const backend = loadSyncedBackend(s) ?? d.backend;
  if (gapOf(backend, d.apiKey, pageHost)) return null;
  const preset = presetOf(backend.provider);
  const u = checkBaseUrl(backend.baseUrl, pageHost);
  if (!preset || !u.ok) return null;
  return { backend: { ...backend, baseUrl: u.url }, apiKey: d.apiKey.trim(), preset };
}
