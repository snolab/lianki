/**
 * The host page's side of the mini-app protocol (docs/mini-apps.md, "The
 * SDK"): the app (public/m/sdk.js, `window.lianki`) posts requests to its
 * parent; the host checks who sent it, asks the user when a capability has no
 * answer yet, calls the server, and posts the reply back. Client-safe and
 * free of React and DOM globals, so the protocol is unit-tested.
 *
 *   app → host  {lk: "mini/1", id, method, args}
 *   host → app  {lk: "mini/1", id, ok: true, result} | {lk: "mini/1", id, ok: false, error, permission?}
 *
 * Methods: `manifest`, `request` {permission}, and every capability method in
 * lib/mini-apps/capabilities.ts.
 */
import { type CapabilityId, capabilityOf, isCapability } from "./capabilities";
import { type Choice, type GrantState, type Grants, grantState } from "./grants";

export const PROTOCOL = "mini/1";

export type BridgeRequest = { id: number; method: string; args: Record<string, unknown> };
export type BridgeReply =
  | { lk: typeof PROTOCOL; id: number; ok: true; result: unknown }
  | { lk: typeof PROTOCOL; id: number; ok: false; error: string; permission?: CapabilityId };

/** A request as the app sent it, or null (anything else on the channel is ignored). */
export function parseRequest(data: unknown): BridgeRequest | null {
  const m = data as { lk?: unknown; id?: unknown; method?: unknown; args?: unknown } | null;
  if (!m || typeof m !== "object" || m.lk !== PROTOCOL) return null;
  if (typeof m.id !== "number" || !Number.isSafeInteger(m.id) || m.id < 0) return null;
  if (typeof m.method !== "string" || m.method.length > 40) return null;
  const args = m.args === undefined ? {} : m.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  return { id: m.id, method: m.method, args: args as Record<string, unknown> };
}

/**
 * Is this message from our iframe? Its window must be the frame's, and its
 * origin the app's own (`"null"` for a srcdoc sandbox).
 */
export function fromFrame(
  e: { source: unknown; origin: string },
  frameWindow: unknown,
  frameOrigin: string,
): boolean {
  return !!frameWindow && e.source === frameWindow && e.origin === frameOrigin;
}

/** Where replies go: the app's origin, or "*" for an opaque srcdoc origin (which cannot be named). */
export const replyTarget = (frameOrigin: string) => (frameOrigin === "null" ? "*" : frameOrigin);

export type BridgeDeps = {
  manifest: { slug: string; name: string; icon: string; version: string; permissions: string[] };
  grants: () => Grants;
  /** Show the prompt card; the user's choice, or null when dismissed. */
  prompt: (cap: CapabilityId) => Promise<Choice | null>;
  /** Store the choice on the server; the grants after it. */
  decide: (cap: CapabilityId, choice: Choice) => Promise<Grants>;
  /** POST the call; the server's status and JSON. */
  call: (
    method: string,
    args: Record<string, unknown>,
  ) => Promise<{ status: number; body: unknown }>;
  onGrants?: (g: Grants) => void;
};

/** A prompt closed without an answer: this call fails, the next one asks again. */
type Ensured = GrantState | "dismissed";

export function createBridge(d: BridgeDeps) {
  let grants = d.grants();
  // One prompt at a time; a second request for the same capability waits on the first.
  const pending = new Map<CapabilityId, Promise<Ensured>>();
  let queue: Promise<unknown> = Promise.resolve();

  const ok = (id: number, result: unknown): BridgeReply => ({ lk: PROTOCOL, id, ok: true, result });
  const fail = (id: number, error: string, permission?: CapabilityId): BridgeReply => ({
    lk: PROTOCOL,
    id,
    ok: false,
    error,
    ...(permission ? { permission } : {}),
  });

  const states = () =>
    Object.fromEntries(
      d.manifest.permissions.map((p) => [p, grantState(d.manifest.permissions, grants, p)]),
    );

  /** Ask once per capability; "once" and "app" leave it granted, "deny" denied, dismissed: prompt again later. */
  function ensure(cap: CapabilityId): Promise<Ensured> {
    const now = grantState(d.manifest.permissions, grants, cap);
    if (now !== "prompt") return Promise.resolve(now);
    const running = pending.get(cap);
    if (running) return running;
    const p = (queue = queue.then(async () => {
      const again = grantState(d.manifest.permissions, grants, cap);
      if (again !== "prompt") return again;
      const choice = await d.prompt(cap);
      if (!choice) return "dismissed" as const;
      grants = await d.decide(cap, choice);
      d.onGrants?.(grants);
      return grantState(d.manifest.permissions, grants, cap);
    })) as Promise<Ensured>;
    pending.set(cap, p);
    void p.finally(() => pending.delete(cap)).catch(() => {});
    return p;
  }

  async function handle(r: BridgeRequest): Promise<BridgeReply> {
    try {
      if (r.method === "manifest") return ok(r.id, { ...d.manifest, grants: states() });
      if (r.method === "request") {
        const cap = r.args.permission;
        if (!isCapability(cap)) return fail(r.id, "unknown-permission");
        const s = await ensure(cap);
        return ok(r.id, s === "dismissed" ? "prompt" : s);
      }
      const cap = capabilityOf(r.method);
      if (!cap) return fail(r.id, "unknown-method");
      const s = await ensure(cap);
      if (s === "undeclared") return fail(r.id, "permission-undeclared", cap);
      if (s !== "granted") return fail(r.id, "permission-denied", cap);
      const res = await d.call(r.method, r.args);
      const body = (res.body ?? {}) as { error?: unknown };
      // A one-time grant is spent by the call it was given for.
      if (grants[cap] === "once") {
        const { [cap]: _spent, ...rest } = grants;
        grants = rest;
        d.onGrants?.(grants);
      }
      if (res.status >= 400)
        return fail(r.id, typeof body.error === "string" ? body.error : "failed", cap);
      return ok(r.id, res.body);
    } catch {
      return fail(r.id, "failed");
    }
  }

  return { handle, grants: () => grants };
}
