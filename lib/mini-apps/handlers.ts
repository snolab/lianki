/**
 * Mini apps' HTTP side (docs/mini-apps.md), as plain functions over their
 * dependencies so the gates, caps and capability checks are unit-tested
 * (unit/mini-apps-handlers.test.ts). Every route answers 404 while the flag
 * `mini-apps` is off or for a guest; an app is only ever its owner's own.
 *
 *   GET    /api/my/mini-apps              the account's apps and their grants
 *   POST   /api/my/mini-apps              publish {manifest, html} (phase 1: `dev` only)
 *   GET    /api/my/mini-apps/<slug>       one app's manifest and grants
 *   POST   /api/my/mini-apps/<slug>       {action: decide | revoke | call}
 *   DELETE /api/my/mini-apps/<slug>       the app, its grants, its storage, its files
 *   GET    /api/m/<slug>?t=<ticket>       the file itself, for its own origin
 */
import { createHash } from "node:crypto";
import type { D1Like } from "@/lib/d1/types";
import { checkPref, isPrefKey, type PrefKey } from "@/lib/prefs/schema";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";
import { capabilityOf, type CapabilityId, isCapability } from "./capabilities";
import { type ChatPort, laneOfApp, parseCard, SAY_MAX } from "./chat";
import { checkExternalRefs, miniAppCsp, miniAppCspMeta, parseSources, sandboxFlags } from "./csp";
import { decisionOf, grantState, isChoice, type Grants } from "./grants";
import { prepareHtml } from "./html";
import { checkHtml, isSlug, parseManifest } from "./manifest";
import { appOrigin, ownOriginAllowed } from "./origin";
import {
  type MiniApp,
  type MiniDb,
  KV_KEY_RE,
  deleteApp,
  getApp,
  grantsFor,
  htmlKey,
  kvGet,
  kvList,
  kvSet,
  listApps,
  manifestKey,
  newAppId,
  revokeGrant,
  setGrant,
  spendOnce,
  upsertApp,
} from "./store";
import { TICKET_MS, secretUsable, signTicket, verifyTicket } from "./ticket";

export type MiniWho = { id: string; email: string; dev: boolean };

/** The slice of the R2 bucket used here. */
export type MiniBucket = {
  put(
    key: string,
    body: string,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(key: string | string[]): Promise<unknown>;
};

export type MiniConfig = {
  maxBytes: number;
  storageBytes: number;
  perAccount: number;
  callsPerMinute: number;
  cardWaitMs: number;
  /** miniApps.origin: "" (srcdoc), or the apps' own origin template. */
  origin: string;
  scripts: string;
  styles: string;
  fonts: string;
  prefKeys: string;
};

export type MiniDeps = {
  who: () => Promise<MiniWho | null>;
  /** The flag `mini-apps`. */
  on: () => Promise<boolean>;
  db: () => MiniDb;
  bucket: () => MiniBucket;
  config: () => Promise<MiniConfig>;
  chat?: () => ChatPort;
  /** AUTH_SECRET, for the iframe's ticket (separate-origin mode only). */
  secret?: () => string | undefined;
  /** Per-account rate limit (lib/inbox/rate.ts). */
  allow?: (account: string, max: number) => boolean;
  now?: () => number;
};

const NO_STORE = { "cache-control": "private, no-store" };
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE },
  });
const notFound = () => json({ error: "not-found" }, 404);

async function gate(d: MiniDeps): Promise<MiniWho | null> {
  if (!(await d.on())) return null;
  const w = await d.who();
  return w?.id && w.email ? w : null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const view = (a: MiniApp, grants: Grants) => ({
  slug: a.slug,
  name: a.name,
  icon: a.icon,
  version: a.version,
  permissions: a.permissions,
  size: a.size,
  updatedAt: a.updatedMs,
  grants,
});

/** GET /api/my/mini-apps */
export async function listMine(d: MiniDeps): Promise<Response> {
  const who = await gate(d);
  if (!who) return notFound();
  const db = d.db();
  const apps = await listApps(db, who.id);
  const out = await Promise.all(apps.map(async (a) => view(a, await grantsFor(db, who.id, a.id))));
  const c = await d.config();
  return json({ apps: out, canPublish: who.dev, maxBytes: c.maxBytes, perAccount: c.perAccount });
}

/** POST /api/my/mini-apps {manifest, html} — phase 1: accounts holding `dev`. */
export async function publish(req: Request, d: MiniDeps): Promise<Response> {
  const who = await gate(d);
  if (!who) return notFound();
  if (!who.dev) return json({ error: "dev-required" }, 403);
  const c = await d.config();
  if (d.allow && !d.allow(who.id, c.callsPerMinute)) return json({ error: "rate-limited" }, 429);
  const cap = c.maxBytes * 2 + 64 * 1024;
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(len) && len > cap) return json({ error: "too-big", max: c.maxBytes }, 413);
  const text = await req.text();
  if (text.length > cap) return json({ error: "too-big", max: c.maxBytes }, 413);
  let body: { manifest?: unknown; html?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const m = parseManifest(body?.manifest);
  if (!m.ok) return json({ error: m.error }, 400);
  const h = checkHtml(body.html, c.maxBytes);
  if (!h.ok)
    return json(
      { error: h.error, ...(h.max ? { max: h.max } : {}) },
      h.error === "too-big" ? 413 : 400,
    );
  const html = body.html as string;
  const refs = checkExternalRefs(html, {
    scripts: parseSources(c.scripts),
    styles: parseSources(c.styles),
  });
  if (refs) return json({ error: refs.error, url: refs.url }, 400);
  const now = (d.now ?? Date.now)();
  const db = d.db();
  const prev = await getApp(db, who.id, m.manifest.slug);
  const key = htmlKey(who.id, m.manifest.slug);
  const row = {
    ...m.manifest,
    id: prev?.id ?? newAppId(),
    ownerId: who.id,
    size: h.bytes,
    sha256: sha256(html),
    r2Key: key,
    now,
  };
  if (!(await upsertApp(db, row, c.perAccount)))
    return json({ error: "app-cap", max: c.perAccount }, 413);
  const bucket = d.bucket();
  await bucket.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  await bucket.put(manifestKey(who.id, m.manifest.slug), JSON.stringify(m.manifest), {
    httpMetadata: { contentType: "application/json" },
  });
  console.log(JSON.stringify({ event: "mini-app.publish", slug: m.manifest.slug, size: h.bytes }));
  return json(
    {
      slug: m.manifest.slug,
      version: m.manifest.version,
      size: h.bytes,
      url: `/m/${m.manifest.slug}`,
    },
    prev ? 200 : 201,
  );
}

/** GET /api/my/mini-apps/<slug> */
export async function appInfo(slug: string, d: MiniDeps): Promise<Response> {
  const who = await gate(d);
  if (!who || !isSlug(slug)) return notFound();
  const db = d.db();
  const a = await getApp(db, who.id, slug);
  if (!a) return notFound();
  return json(view(a, await grantsFor(db, who.id, a.id)));
}

/** DELETE /api/my/mini-apps/<slug> */
export async function removeApp(slug: string, d: MiniDeps): Promise<Response> {
  const who = await gate(d);
  if (!who || !isSlug(slug)) return notFound();
  const db = d.db();
  const a = await getApp(db, who.id, slug);
  if (!a) return notFound();
  await d.bucket().delete([htmlKey(who.id, slug), manifestKey(who.id, slug)]);
  await deleteApp(db, a);
  console.log(JSON.stringify({ event: "mini-app.delete", slug }));
  return json({ ok: true });
}

/** POST /api/my/mini-apps/<slug> {action: "decide" | "revoke" | "call", …} */
export async function act(req: Request, slug: string, d: MiniDeps): Promise<Response> {
  const who = await gate(d);
  if (!who || !isSlug(slug)) return notFound();
  const text = await req.text();
  if (text.length > 256 * 1024) return json({ error: "too-big" }, 413);
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text);
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  if (!b || typeof b !== "object") return json({ error: "bad-request" }, 400);
  const db = d.db();
  const a = await getApp(db, who.id, slug);
  if (!a) return notFound();
  const now = (d.now ?? Date.now)();
  if (b.action === "decide") {
    if (!isCapability(b.permission) || !a.permissions.includes(b.permission))
      return json({ error: "permission-undeclared" }, 400);
    if (!isChoice(b.choice)) return json({ error: "bad-choice" }, 400);
    await setGrant(db, who.id, a.id, b.permission, decisionOf(b.choice), now);
    return json({ grants: await grantsFor(db, who.id, a.id) });
  }
  if (b.action === "revoke") {
    if (!isCapability(b.permission)) return json({ error: "bad-request" }, 400);
    await revokeGrant(db, who.id, a.id, b.permission);
    return json({ grants: await grantsFor(db, who.id, a.id) });
  }
  if (b.action !== "call") return json({ error: "bad-request" }, 400);
  const cap = capabilityOf(b.method);
  if (!cap) return json({ error: "unknown-method" }, 400);
  const state = grantState(a.permissions, await grantsFor(db, who.id, a.id), cap);
  if (state === "undeclared") return json({ error: "permission-undeclared", permission: cap }, 403);
  if (state === "denied") return json({ error: "permission-denied", permission: cap }, 403);
  if (state === "prompt") return json({ error: "permission-required", permission: cap }, 403);
  const c = await d.config();
  if (d.allow && !d.allow(who.id, c.callsPerMinute)) return json({ error: "rate-limited" }, 429);
  const grants = await grantsFor(db, who.id, a.id);
  if (grants[cap] === "once" && !(await spendOnce(db, who.id, a.id, cap)))
    return json({ error: "permission-required", permission: cap }, 403);
  return runMethod(String(b.method), (b.args ?? {}) as Record<string, unknown>, {
    who,
    a,
    d,
    db,
    c,
    now,
  });
}

type Ctx = { who: MiniWho; a: MiniApp; d: MiniDeps; db: MiniDb; c: MiniConfig; now: number };

/** The account preferences an app may see (config ∩ the schema's keys). */
export const appPrefKeys = (raw: string): PrefKey[] =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((k, i, all): k is PrefKey => isPrefKey(k) && all.indexOf(k) === i);

async function runMethod(method: string, args: Record<string, unknown>, x: Ctx): Promise<Response> {
  const { who, a, d, db, c, now } = x;
  switch (method) {
    case "storage.get": {
      if (typeof args.key !== "string" || !KV_KEY_RE.test(args.key))
        return json({ error: "bad-key" }, 400);
      return json({ value: await kvGet(db, a.id, args.key) });
    }
    case "storage.set": {
      if (typeof args.key !== "string" || !KV_KEY_RE.test(args.key))
        return json({ error: "bad-key" }, 400);
      const ok = await kvSet(db, a.id, args.key, args.value, c.storageBytes, now);
      return ok ? json({ ok: true }) : json({ error: "storage-full", max: c.storageBytes }, 413);
    }
    case "storage.list": {
      const prefix = typeof args.prefix === "string" ? args.prefix.slice(0, 128) : "";
      return json({ ...(await kvList(db, a.id, prefix)), max: c.storageBytes });
    }
    case "prefs.get": {
      const allowed = appPrefKeys(c.prefKeys);
      const want = Array.isArray(args.keys)
        ? allowed.filter((k) => (args.keys as unknown[]).includes(k))
        : allowed;
      const repo = new UserPrefsD1Repo(db as unknown as D1Like, who.id);
      const prefs: Record<string, unknown> = {};
      for (const k of want) {
        const v = await repo.value(k);
        if (v !== undefined) prefs[k] = v;
      }
      return json({ prefs, keys: allowed });
    }
    case "prefs.set": {
      const allowed = appPrefKeys(c.prefKeys);
      if (typeof args.key !== "string" || !(allowed as string[]).includes(args.key))
        return json({ error: "pref-not-allowed" }, 403);
      if (checkPref(args.key, args.value) === undefined) return json({ error: "bad-value" }, 400);
      const repo = new UserPrefsD1Repo(db as unknown as D1Like, who.id);
      const out = await repo.write([
        {
          key: args.key,
          value: args.value,
          hlc: { timestamp: now, counter: 0, deviceId: `app${a.id}` },
        },
      ]);
      return out.rejected.length ? json({ error: "bad-value" }, 400) : json({ ok: true });
    }
    case "chat.read": {
      const port = d.chat?.();
      if (!port) return json({ error: "chat-unavailable" }, 503);
      const limit = typeof args.limit === "number" ? args.limit : 20;
      return json({ lines: await port.read(who, limit) });
    }
    case "chat.say": {
      const port = d.chat?.();
      if (!port) return json({ error: "chat-unavailable" }, 503);
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text || text.length > SAY_MAX) return json({ error: "bad-text" }, 400);
      const r = await port.say(who, laneOfApp(a.slug), text);
      return "error" in r ? json(r, 502) : json(r);
    }
    default: {
      // ui.card: the only other method capabilityOf knows.
      const port = d.chat?.();
      if (!port) return json({ error: "chat-unavailable" }, 503);
      const card = parseCard(args);
      if (!card) return json({ error: "bad-card" }, 400);
      const r = await port.card(who, laneOfApp(a.slug), card, c.cardWaitMs);
      return "error" in r ? json(r, 502) : json(r);
    }
  }
}

// ── The frame ───────────────────────────────────────────────────────────────

export type Frame =
  | { mode: "srcdoc"; srcdoc: string; sandbox: string }
  | { mode: "origin"; src: string; origin: string; sandbox: string };

export type HostView = {
  slug: string;
  name: string;
  icon: string;
  version: string;
  permissions: CapabilityId[];
  grants: Grants;
  frame: Frame;
};

/**
 * What /m/<slug> renders for the signed-in owner: the manifest, the grants,
 * and the frame — on the apps' own origin with a signed ticket when
 * miniApps.origin is set (and AUTH_SECRET usable), else srcdoc with the CSP
 * as a <meta>. `host` is the page's origin. Null: 404.
 */
export async function hostView(slug: string, host: string, d: MiniDeps): Promise<HostView | null> {
  const who = await gate(d);
  if (!who || !isSlug(slug)) return null;
  const db = d.db();
  const a = await getApp(db, who.id, slug);
  if (!a) return null;
  const c = await d.config();
  const grants = await grantsFor(db, who.id, a.id);
  const base = {
    slug,
    name: a.name,
    icon: a.icon,
    version: a.version,
    permissions: a.permissions,
    grants,
  };
  const origin = appOrigin(c.origin, a.id);
  const secret = d.secret?.();
  if (origin && secretUsable(secret)) {
    const now = (d.now ?? Date.now)();
    const t = await signTicket(
      {
        u: who.id,
        a: a.id,
        s: slug,
        h: a.sha256.slice(0, 16),
        b: host,
        f: host,
        e: now + TICKET_MS,
      },
      secret,
    );
    return {
      ...base,
      frame: {
        mode: "origin",
        src: `${origin}/api/m/${slug}?t=${encodeURIComponent(t)}`,
        origin,
        sandbox: sandboxFlags(ownOriginAllowed(c.origin, origin, host)),
      },
    };
  }
  const obj = await d.bucket().get(a.r2Key);
  if (!obj) return null;
  const csp = miniAppCspMeta({
    scripts: parseSources(c.scripts),
    styles: parseSources(c.styles),
    fonts: parseSources(c.fonts),
    assets: host,
  });
  return {
    ...base,
    frame: {
      mode: "srcdoc",
      srcdoc: prepareHtml(await obj.text(), { sdkSrc: `${host}/m/sdk.js`, cspMeta: csp }),
      sandbox: sandboxFlags(false),
    },
  };
}

/**
 * GET /api/m/<slug>?t=<ticket> on the apps' own origin: the file, with the
 * CSP (sandbox and frame-ancestors included) as a header. No session is read:
 * the ticket alone names the account, the app and the file's hash.
 */
export async function serveApp(req: Request, slug: string, d: MiniDeps): Promise<Response> {
  if (!(await d.on()) || !isSlug(slug)) return notFound();
  const secret = d.secret?.();
  if (!secretUsable(secret)) return notFound();
  const url = new URL(req.url);
  const t = await verifyTicket(url.searchParams.get("t"), secret, (d.now ?? Date.now)());
  if (!t || t.s !== slug) return notFound();
  const c = await d.config();
  const origin = appOrigin(c.origin, t.a);
  // Only on the app's own origin: never lianki.com, never another app's.
  if (!origin || origin !== url.origin) return notFound();
  const a = await getApp(d.db(), t.u, slug);
  if (!a || a.id !== t.a || a.sha256.slice(0, 16) !== t.h) return notFound();
  const obj = await d.bucket().get(a.r2Key);
  if (!obj) return notFound();
  const sandbox = sandboxFlags(ownOriginAllowed(c.origin, origin, t.f));
  const csp = miniAppCsp({
    scripts: parseSources(c.scripts),
    styles: parseSources(c.styles),
    fonts: parseSources(c.fonts),
    assets: [t.b, origin],
    ancestors: t.f,
    sandbox,
  });
  return new Response(prepareHtml(await obj.text(), { sdkSrc: `${t.b}/m/sdk.js` }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      ...NO_STORE,
    },
  });
}
