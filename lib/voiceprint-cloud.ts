/**
 * The voiceprint in the account (docs/local-stt.md, "Voiceprint in your
 * account"; owner decision 2026-11-10 23:31 JST). The Mac's print, the voice
 * FEATURES only (CAM++ embeddings, their mean, sentence lengths, self scores:
 * numbers, never audio), kept in D1 `voiceprint`, one row per account, device
 * and model, encrypted at rest. app/api/my/voiceprint is the route; this is
 * the logic, without the request plumbing, so it is unit-tested.
 *
 *   GET                       → {prints:[{device, model, dim, n, updatedAt}]}  the session's own rows
 *   GET ?features=1           → the same with each row's features, decrypted   the session only
 *   PUT {ticket, prints:[…]}  → store them   an `export` ticket (passkey, UV) for this account
 *                             (or `enrol` for its own device: a print re-computed from his recordings)
 *   DELETE {ticket, device}   → delete one device's rows, or "*" all of them   a `delete` ticket
 *
 * - **Own rows only.** Every statement is by the session's user id; nothing in
 *   a request names an account, and a ticket approved for another account is
 *   refused (`uid`).
 * - **Writes need the passkey.** The ticket is the voiceprint ticket the Mac
 *   takes (lib/voiceprint-ticket.ts): signed with STT_TICKET_KEY, aud
 *   lianki-voiceprint, `uv: true`, 60 s, for this op and device (or "*"). It is
 *   spent here once (D1 `verification`, `voiceprint-cloud:<jti>`), apart from
 *   the Mac's own single-use store, so one approval does the Mac's half and
 *   this half of one tap.
 * - **Nothing but features.** A print with any key outside PRINT_KEYS (an
 *   `audio` flag, a wav, a path, text) is refused whole, and so is a body with
 *   keys besides `ticket` and `prints`.
 * - **At rest.** AES-256-GCM, the key derived by HKDF-SHA256 from the existing
 *   Worker secret AUTH_SECRET with its own salt and info (VOICEPRINT_KEY_INFO),
 *   so no new secret, and not the key that seals Google tokens. The AAD is the
 *   row's user, device and model: a payload copied into another row does not
 *   open. Rotating AUTH_SECRET makes the stored prints unreadable (they read as
 *   `unreadable`; save again from the Mac).
 */
import type { D1Database } from "@cloudflare/workers-types";
import { seal, unseal } from "@/lib/connections/crypto";
import { type VoiceprintOp, VOICEPRINT_AUD, openPayload } from "@/lib/voiceprint-ticket";

/** Limits (named config, ready for the config store): a print as the Mac makes it. */
export const VOICEPRINT_CLOUD_LIMITS = {
  /** Sentences a print holds at most (voiceprint.py ENROL_MAX). */
  maxSentences: 20,
  /** Prints in one PUT (devices × models). */
  maxPrints: 16,
  /** Embedding width (CAM++ 192; ERes2NetV2 is wider). */
  maxDim: 1024,
  /** The sealed payload's length at most. */
  maxSealed: 600_000,
  /** Ticket lifetime and clock skew, as the Mac's ticket.py. */
  ticketTtlS: 60,
  skewS: 5,
} as const;

export const MODELS = ["campp", "eres2netv2"] as const;
/** Every key a print may carry. Anything else is refused: features only, never audio. */
export const PRINT_KEYS = [
  "device",
  "model",
  "dim",
  "n",
  "created",
  "updated",
  "self",
  "speechS",
  "centroid",
  "embeddings",
] as const;
const REQUIRED = ["device", "model", "dim", "n", "speechS", "centroid", "embeddings"] as const;
const DEVICE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type Features = {
  centroid: number[];
  embeddings: number[][];
  speechS: number[];
  self: { min: number; median: number } | null;
  created: string | null;
  updated: string | null;
};
export type CloudPrint = { device: string; model: string; dim: number; n: number } & Features;
export type PrintRow = {
  device: string;
  model: string;
  dim: number;
  n: number;
  updatedAt: string;
};

const finite = (x: unknown, lim = 4): x is number =>
  typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= lim;
const vec = (v: unknown, dim: number): v is number[] =>
  Array.isArray(v) && v.length === dim && v.every((x) => finite(x));
const stamp = (v: unknown) =>
  v === undefined || v === null ? null : typeof v === "string" && v.length <= 40 ? v : undefined;

/** One print, checked strictly; a reason string when it is not exactly features. */
export function parsePrint(raw: unknown): CloudPrint | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "not an object";
  const p = raw as Record<string, unknown>;
  const extra = Object.keys(p).filter((k) => !(PRINT_KEYS as readonly string[]).includes(k));
  if (extra.length) return `not features: ${extra.slice(0, 3).join(", ")}`;
  for (const k of REQUIRED) if (!(k in p)) return `missing ${k}`;
  const L = VOICEPRINT_CLOUD_LIMITS;
  if (typeof p.device !== "string" || !DEVICE.test(p.device)) return "bad device";
  if (!(MODELS as readonly unknown[]).includes(p.model)) return "bad model";
  const dim = p.dim;
  if (!Number.isInteger(dim) || (dim as number) < 1 || (dim as number) > L.maxDim) return "bad dim";
  const n = p.n;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > L.maxSentences) return "bad n";
  if (!vec(p.centroid, dim as number)) return "bad centroid";
  if (
    !Array.isArray(p.embeddings) ||
    p.embeddings.length !== n ||
    !p.embeddings.every((e) => vec(e, dim as number))
  )
    return "bad embeddings";
  if (
    !Array.isArray(p.speechS) ||
    p.speechS.length !== n ||
    !p.speechS.every((s) => finite(s, 600) && s >= 0)
  )
    return "bad speechS";
  let self: Features["self"] = null;
  if (p.self !== undefined && p.self !== null) {
    const s = p.self as Record<string, unknown>;
    if (
      typeof s !== "object" ||
      Object.keys(s).some((k) => k !== "min" && k !== "median") ||
      !finite(s.min, 1) ||
      !finite(s.median, 1)
    )
      return "bad self";
    self = { min: s.min as number, median: s.median as number };
  }
  const created = stamp(p.created);
  const updated = stamp(p.updated);
  if (created === undefined || updated === undefined) return "bad time";
  return {
    device: p.device,
    model: p.model as string,
    dim: dim as number,
    n: n as number,
    centroid: p.centroid as number[],
    embeddings: p.embeddings as number[][],
    speechS: p.speechS as number[],
    self,
    created,
    updated,
  };
}

/** A PUT body: exactly {ticket, prints}, each print exactly features. */
export function parsePut(body: unknown): { ticket: string; prints: CloudPrint[] } | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "bad body";
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => k !== "ticket" && k !== "prints")) return "bad body";
  if (typeof b.ticket !== "string") return "no ticket";
  if (!Array.isArray(b.prints) || !b.prints.length) return "no prints";
  if (b.prints.length > VOICEPRINT_CLOUD_LIMITS.maxPrints) return "too many prints";
  const prints: CloudPrint[] = [];
  const seen = new Set<string>();
  for (const raw of b.prints) {
    const p = parsePrint(raw);
    if (typeof p === "string") return p;
    const id = `${p.device}.${p.model}`;
    if (seen.has(id)) return "duplicate print";
    seen.add(id);
    prints.push(p);
  }
  return { ticket: b.ticket, prints };
}

/**
 * A voiceprint ticket for this op, approved with the passkey (uv) for this
 * account, live, and for `device` (a "*" ticket covers every device). The jti
 * to spend, or why not. Mirrors scripts/local-stt/ticket.py's checks.
 */
export async function checkCloudTicket(
  ticket: string,
  pub: CryptoKey,
  want: {
    op: VoiceprintOp | readonly VoiceprintOp[];
    uid: string;
    devices: string[];
    now?: number;
  },
): Promise<{ jti: string; exp: number } | { error: string }> {
  const p = await openPayload(ticket, pub);
  if (!p) return { error: "bad ticket" };
  if (p.aud !== VOICEPRINT_AUD) return { error: "wrong aud" };
  const ops: readonly unknown[] = typeof want.op === "string" ? [want.op] : want.op;
  if (!ops.includes(p.op)) return { error: "wrong op" };
  if (p.uv !== true) return { error: "no passkey" };
  if (typeof p.uid !== "string" || p.uid !== want.uid) return { error: "not your ticket" };
  const d = p.device;
  if (typeof d !== "string" || (d !== "*" && want.devices.some((x) => x !== d)))
    return { error: "wrong device" };
  const now = Math.floor((want.now ?? Date.now()) / 1000);
  const { exp, iat, jti } = p;
  const L = VOICEPRINT_CLOUD_LIMITS;
  if (typeof exp !== "number" || typeof iat !== "number" || typeof jti !== "string" || !jti)
    return { error: "bad ticket" };
  if (exp - iat > L.ticketTtlS || iat > now + L.skewS) return { error: "bad lifetime" };
  if (exp + L.skewS < now) return { error: "expired" };
  return { jti, exp };
}

// ---------------------------------------------------------------- at rest
export const VOICEPRINT_KEY_SALT = "lianki/voiceprint";
export const VOICEPRINT_KEY_INFO = "lianki/voiceprint/features-at-rest/v1";
const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

/** The AES key for voiceprints at rest, derived from AUTH_SECRET (no new secret). */
export function voiceprintKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("voiceprint: AUTH_SECRET missing or short");
  let k = keyCache.get(secret);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: enc.encode(VOICEPRINT_KEY_SALT),
          info: enc.encode(VOICEPRINT_KEY_INFO),
        },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(secret, k);
  }
  return k;
}
const aadOf = (uid: string, device: string, model: string) =>
  `voiceprint\0${uid}\0${device}\0${model}`;
const featuresOf = (p: CloudPrint): Features => ({
  centroid: p.centroid,
  embeddings: p.embeddings,
  speechS: p.speechS,
  self: p.self,
  created: p.created,
  updated: p.updated,
});
export const sealPrint = (key: CryptoKey, uid: string, p: CloudPrint) =>
  seal(key, JSON.stringify(featuresOf(p)), aadOf(uid, p.device, p.model));
export async function openPrint(
  key: CryptoKey,
  uid: string,
  row: { device: string; model: string; payload: string },
): Promise<Features | null> {
  const s = await unseal(
    key,
    row.payload,
    aadOf(uid, row.device, row.model),
    VOICEPRINT_CLOUD_LIMITS.maxSealed,
  );
  if (s === null) return null;
  try {
    return JSON.parse(s) as Features;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the store
export type VoiceprintDb = {
  list(uid: string): Promise<(PrintRow & { payload: string })[]>;
  put(uid: string, rows: (PrintRow & { payload: string })[]): Promise<void>;
  /** Device null: every row of the account. Count deleted. */
  delete(uid: string, device: string | null): Promise<number>;
  /** Spend a ticket's jti (atomic, once): true the first time. */
  spend(jti: string, exp: number): Promise<boolean>;
};
export type CloudDeps = {
  uid: string;
  db: VoiceprintDb;
  key: () => Promise<CryptoKey>;
  pub: () => Promise<CryptoKey>;
  now?: number;
};
type Out = { status: number; json: Record<string, unknown> };
const bad = (status: number, error: string): Out => ({ status, json: { error } });

export async function listPrints(d: CloudDeps, withFeatures: boolean): Promise<Out> {
  const rows = await d.db.list(d.uid);
  const key = withFeatures ? await d.key() : null;
  const prints = [];
  for (const r of rows) {
    const base = { device: r.device, model: r.model, dim: r.dim, n: r.n, updatedAt: r.updatedAt };
    if (!key) {
      prints.push(base);
      continue;
    }
    const f = await openPrint(key, d.uid, r);
    prints.push(f ? { ...base, ...f } : { ...base, unreadable: true });
  }
  return { status: 200, json: { prints } };
}

const spendTicket = async (
  d: CloudDeps,
  ticket: string,
  op: VoiceprintOp | readonly VoiceprintOp[],
  devices: string[],
) => {
  const t = await checkCloudTicket(ticket, await d.pub(), { op, uid: d.uid, devices, now: d.now });
  if ("error" in t) return t;
  if (!(await d.db.spend(t.jti, t.exp))) return { error: "approval already used" };
  return t;
};

export async function putPrints(d: CloudDeps, body: unknown): Promise<Out> {
  const b = parsePut(body);
  if (typeof b === "string") return bad(400, b);
  // `export` (Save to my account), or `enrol` for the device it enrolled: a print
  // re-computed from his recordings comes back under that one approval
  // (an enrol ticket is never "*", so it covers only its own device).
  const t = await spendTicket(
    d,
    b.ticket,
    ["export", "enrol"],
    b.prints.map((p) => p.device),
  );
  if ("error" in t) return bad(401, t.error);
  const key = await d.key();
  const at = new Date(d.now ?? Date.now()).toISOString();
  const rows = [];
  for (const p of b.prints)
    rows.push({
      device: p.device,
      model: p.model,
      dim: p.dim,
      n: p.n,
      updatedAt: at,
      payload: await sealPrint(key, d.uid, p),
    });
  if (rows.some((r) => r.payload.length > VOICEPRINT_CLOUD_LIMITS.maxSealed))
    return bad(413, "too large");
  await d.db.put(d.uid, rows);
  return { status: 200, json: { ok: true, saved: rows.length, updatedAt: at } };
}

export async function deletePrints(d: CloudDeps, body: unknown): Promise<Out> {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const device = b.device;
  if (typeof b.ticket !== "string") return bad(400, "no ticket");
  if (typeof device !== "string" || (device !== "*" && !DEVICE.test(device)))
    return bad(400, "bad device");
  // A "*" delete needs a "*" ticket; a one-device ticket deletes only that device.
  const t = await spendTicket(d, b.ticket, "delete", [device]);
  if ("error" in t) return bad(401, t.error);
  const n = await d.db.delete(d.uid, device === "*" ? null : device);
  return { status: 200, json: { ok: true, deleted: n } };
}

/** D1 statements for VoiceprintDb (db/migrations/0071_voiceprint.sql). */
export function d1VoiceprintDb(db: D1Database): VoiceprintDb {
  return {
    async list(uid) {
      const r = await db
        .prepare(
          "SELECT device, model, dim, n, payload, updated_at AS updatedAt FROM voiceprint WHERE user_id = ? ORDER BY device, model",
        )
        .bind(uid)
        .all<PrintRow & { payload: string }>();
      return r.results;
    },
    async put(uid, rows) {
      await db.batch(
        rows.map((r) =>
          db
            .prepare(
              "INSERT INTO voiceprint (user_id, device, model, dim, n, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT (user_id, device, model) DO UPDATE SET dim = excluded.dim, n = excluded.n, payload = excluded.payload, updated_at = excluded.updated_at",
            )
            .bind(uid, r.device, r.model, r.dim, r.n, r.payload, r.updatedAt),
        ),
      );
    },
    async delete(uid, device) {
      const r =
        device === null
          ? await db.prepare("DELETE FROM voiceprint WHERE user_id = ?").bind(uid).run()
          : await db
              .prepare("DELETE FROM voiceprint WHERE user_id = ? AND device = ?")
              .bind(uid, device)
              .run();
      return r.meta?.changes ?? 0;
    },
    async spend(jti, exp) {
      const now = new Date().toISOString();
      const r = await db
        .prepare(
          "INSERT OR IGNORE INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          `voiceprint-cloud:${jti}`,
          "voiceprint-cloud",
          "used",
          new Date(exp * 1000 + 60_000).toISOString(),
          now,
          now,
        )
        .run();
      return (r.meta?.changes ?? 0) === 1;
    },
  };
}
