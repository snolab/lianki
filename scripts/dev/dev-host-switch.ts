#!/usr/bin/env bun
/**
 * Point https://dev.lianki.com at THIS Mac's userscript dev server (the dev
 * loader, scripts/dev-userscript-server.ts on :3003), and back — through the
 * Cloudflare API, with the previous DNS records kept for an exact rollback
 * (docs/dev-userscript-loader.md, "Switching dev.lianki.com to this Mac").
 *
 *   bun scripts/dev/dev-host-switch.ts plan          # read-only: old → new, and the rollback
 *   bun scripts/dev/dev-host-switch.ts up --yes      # tunnel + ingress + token file + DNS
 *   bun scripts/dev/dev-host-switch.ts down          # DNS back exactly, tunnel deleted, token file gone
 *   bun scripts/dev/dev-host-switch.ts status
 *
 * scripts/dev/dev-host-switch.sh wraps it and runs the connector (cloudflared
 * with a token FILE) under oxmgr. Nothing here prints a token.
 *
 * - `up` without `--yes` only prints the plan: DNS changes need the owner's tap.
 * - The records found at dev.lianki.com before the first `up` are written to
 *   PREV_FILE (0600) once, and never overwritten by a later `up`, so `down`
 *   restores what was there before any switch: same type, content, proxied,
 *   TTL and comment.
 * - The tunnel is remotely managed (config_src "cloudflare"); its ingress
 *   reaches only the dev server's port, everything else is 404 at the connector.
 *
 * API token: CLOUDFLARE_API_TOKEN, else ~/.config/lianki/cf-api-token (a
 * regular file of this user, 0600, not a symlink). It needs, on lianki.com:
 * Account · Cloudflare Tunnel · Edit, Zone · DNS · Edit, Zone · Zone · Read.
 *
 * Small on purpose and self-contained: PR #399's scripts/ops/cf-tunnel.ts
 * holds the same helpers for preview.lianki.com; fold these into it once
 * that merges.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export const HOST = "dev.lianki.com";
export const ZONE = "lianki.com";
export const TUNNEL_NAME = "lianki-dev-loader-mac";
export const PORT = Number(process.env.DEV_LOADER_PORT || 3003);
const CFG = `${homedir()}/.config/lianki`;
export const PATHS = {
  apiToken: process.env.CF_API_TOKEN_FILE || `${CFG}/cf-api-token`,
  prev: process.env.DEV_HOST_PREV_FILE || `${CFG}/dev-host-prev.json`,
  runToken: process.env.DEV_HOST_TUNNEL_TOKEN_FILE || `${CFG}/dev-host-tunnel-token`,
};

export type Rec = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
};
export type Prev = { host: string; at: string; records: Omit<Rec, "id">[] };
type Tunnel = { id: string; name: string };
type Zone = { id: string; account: { id: string } };

export type Cf = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T | undefined>;

/** One API call: the result; undefined for a GET that 404s; throws with the API's message, never the token. */
export function makeCf(token: string, f: typeof fetch = fetch): Cf {
  return async <T>(method: string, path: string, body?: unknown) => {
    const res = await f(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && method === "GET") return undefined;
    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: { code?: number; message?: string }[];
    };
    if (!res.ok || !data.success)
      throw new Error(
        `${method} ${path}: ${res.status} ${(data.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim()).join("; ")}`,
      );
    return data.result;
  };
}

/** Why a secret file must not be used (missing, symlink, not ours, not 0600), or null. */
export function secretFileProblem(path: string, uid = process.getuid?.() ?? -1): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return "does not exist";
  }
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isFile()) return "is not a regular file";
  if (st.uid !== uid) return "is not owned by this user";
  if (st.mode & 0o077) return "is readable or writable by group or others (want 0600)";
  return null;
}

export function apiToken(
  env: Record<string, string | undefined> = process.env,
  path = PATHS.apiToken,
): string {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN.trim();
  const why = secretFileProblem(path);
  if (why) throw new Error(`no Cloudflare API token: ${path} ${why}`);
  const t = readFileSync(path, "utf8").trim();
  if (!t) throw new Error(`no Cloudflare API token: ${path} is empty`);
  return t;
}

/** A fresh 0600 file; an existing file or symlink is removed, never written through. */
export function writeSecretFile(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  writeFileSync(path, value, { mode: 0o600, flag: "wx" });
}

export const tunnelTarget = (id: string) => `${id}.cfargotunnel.com`;
const keep = ({ id: _id, ...r }: Rec): Omit<Rec, "id"> => ({
  type: r.type,
  name: r.name,
  content: r.content,
  proxied: r.proxied,
  ttl: r.ttl,
  comment: r.comment ?? null,
});

export async function zoneOf(cf: Cf): Promise<Zone> {
  const z = ((await cf<Zone[]>("GET", `/zones?name=${ZONE}`)) ?? [])[0];
  if (!z) throw new Error(`zone ${ZONE} is not visible to this token`);
  return z;
}

export async function records(cf: Cf, zone: string): Promise<Rec[]> {
  return (await cf<Rec[]>("GET", `/zones/${zone}/dns_records?name=${HOST}`)) ?? [];
}

export async function findTunnel(cf: Cf, account: string): Promise<Tunnel | undefined> {
  const list =
    (await cf<Tunnel[]>(
      "GET",
      `/accounts/${account}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false`,
    )) ?? [];
  return list[0];
}

export function ingress(port = PORT) {
  return {
    config: {
      ingress: [
        { hostname: HOST, service: `http://localhost:${port}` },
        { service: "http_status:404" },
      ],
    },
  };
}

/** What `up` would change, as lines for the owner: old → new, and the rollback. */
export function planText(current: Rec[], tunnelId: string | undefined, prevKept: boolean): string {
  const show = (r: Omit<Rec, "id">) =>
    `${r.type} ${r.name} → ${r.content} (proxied ${r.proxied ? "on" : "off"}, ttl ${r.ttl ?? "auto"})`;
  const target = tunnelId ? tunnelTarget(tunnelId) : `<new tunnel ${TUNNEL_NAME}>.cfargotunnel.com`;
  return [
    `now:  ${current.length ? current.map(show).join("\n      ") : `(no record for ${HOST})`}`,
    `new:  CNAME ${HOST} → ${target} (proxied on) — tunnel ${TUNNEL_NAME}, ingress ${HOST} → http://localhost:${PORT} only`,
    prevKept
      ? `rollback file already holds the records from before the first switch: ${PATHS.prev}`
      : `rollback: the "now" records are saved to ${PATHS.prev} (0600) before anything changes`,
    `undo: bash scripts/dev/dev-host-switch.sh down`,
  ].join("\n");
}

export async function up(cf: Cf, o: { yes: boolean; log: (s: string) => void }) {
  const zone = await zoneOf(cf);
  const account = zone.account.id;
  const current = await records(cf, zone.id);
  let tunnel = await findTunnel(cf, account);
  const prevKept = existsSync(PATHS.prev);
  o.log(planText(current, tunnel?.id, prevKept));
  if (!o.yes) {
    o.log("plan only: nothing changed (add --yes once the owner has approved)");
    return false;
  }
  // 1. Keep what is there now, once, before anything changes.
  if (!prevKept) {
    const prev: Prev = { host: HOST, at: new Date().toISOString(), records: current.map(keep) };
    writeSecretFile(PATHS.prev, `${JSON.stringify(prev, null, 2)}\n`);
  }
  // 2. The tunnel and its ingress, then its run token (0600, for the connector).
  tunnel ??= await cf<Tunnel>("POST", `/accounts/${account}/cfd_tunnel`, {
    name: TUNNEL_NAME,
    config_src: "cloudflare",
  });
  if (!tunnel) throw new Error("tunnel create returned nothing");
  await cf("PUT", `/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`, ingress());
  const run = await cf<string>("GET", `/accounts/${account}/cfd_tunnel/${tunnel.id}/token`);
  if (typeof run !== "string" || !run) throw new Error("no run token for the tunnel");
  writeSecretFile(PATHS.runToken, `${run}\n`);
  // 3. DNS last: every record at the name goes, one proxied CNAME to the tunnel comes.
  const target = tunnelTarget(tunnel.id);
  if (!(current.length === 1 && current[0].type === "CNAME" && current[0].content === target)) {
    for (const r of current) await cf("DELETE", `/zones/${zone.id}/dns_records/${r.id}`);
    await cf("POST", `/zones/${zone.id}/dns_records`, {
      type: "CNAME",
      name: HOST,
      content: target,
      proxied: true,
      ttl: 1,
      comment: `lianki dev loader on this Mac (${TUNNEL_NAME}); undo: dev-host-switch.sh down`,
    });
  }
  o.log(`up: ${HOST} → ${target}`);
  return true;
}

export async function down(cf: Cf, o: { log: (s: string) => void }) {
  const zone = await zoneOf(cf);
  const account = zone.account.id;
  const tunnel = await findTunnel(cf, account);
  if (!existsSync(PATHS.prev)) {
    o.log(`no rollback file at ${PATHS.prev}: DNS left as it is`);
  } else {
    const prev = JSON.parse(readFileSync(PATHS.prev, "utf8")) as Prev;
    // Only records that point at OUR tunnel are removed; then the saved ones come back exactly.
    const ours = tunnel ? tunnelTarget(tunnel.id) : null;
    for (const r of await records(cf, zone.id))
      if (ours && r.content === ours) await cf("DELETE", `/zones/${zone.id}/dns_records/${r.id}`);
    const now = await records(cf, zone.id);
    for (const r of prev.records) {
      const there = now.some((x) => x.type === r.type && x.content === r.content);
      if (!there) await cf("POST", `/zones/${zone.id}/dns_records`, r);
    }
    renameSync(PATHS.prev, `${PATHS.prev}.restored-${Date.now()}`);
    o.log(
      `DNS restored: ${prev.records.map((r) => `${r.type} ${r.content}`).join(", ") || "(no record)"}`,
    );
  }
  if (tunnel) {
    await cf("DELETE", `/accounts/${account}/cfd_tunnel/${tunnel.id}/connections`);
    await cf("DELETE", `/accounts/${account}/cfd_tunnel/${tunnel.id}`);
    o.log(`tunnel ${TUNNEL_NAME} deleted`);
  }
  rmSync(PATHS.runToken, { force: true });
}

export async function status(cf: Cf, o: { log: (s: string) => void }) {
  const zone = await zoneOf(cf);
  const tunnel = await findTunnel(cf, zone.account.id);
  const recs = await records(cf, zone.id);
  o.log(
    `records: ${recs.map((r) => `${r.type} ${r.content} (proxied ${r.proxied ? "on" : "off"})`).join("; ") || "none"}`,
  );
  o.log(`tunnel:  ${tunnel ? `${TUNNEL_NAME} ${tunnel.id}` : "none"}`);
  o.log(
    `points at this Mac: ${tunnel && recs.some((r) => r.content === tunnelTarget(tunnel.id)) ? "yes" : "no"}`,
  );
  o.log(`rollback file: ${existsSync(PATHS.prev) ? PATHS.prev : "none"}`);
}

if (import.meta.main) {
  const cmd = Bun.argv[2] ?? "";
  const log = (s: string) => console.log(s);
  try {
    const cf = makeCf(apiToken());
    if (cmd === "plan") await up(cf, { yes: false, log });
    else if (cmd === "up") await up(cf, { yes: Bun.argv.includes("--yes"), log });
    else if (cmd === "down") await down(cf, { log });
    else if (cmd === "status") await status(cf, { log });
    else {
      console.error("usage: dev-host-switch.ts plan | up --yes | down | status");
      process.exit(2);
    }
  } catch (e) {
    console.error(`dev-host-switch: ${(e as Error).message}`);
    process.exit(1);
  }
}
