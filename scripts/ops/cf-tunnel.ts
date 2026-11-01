#!/usr/bin/env bun
/**
 * The Cloudflare side of the whole-page dev server's public tunnel,
 * https://preview.lianki.com (docs/dev-whole-page.md, "Off the tailnet"), all
 * through the API: a remotely managed tunnel (config_src "cloudflare") whose
 * ingress reaches ONLY the guard's tunnel listener, the proxied CNAME, the
 * shared rate-limiting rule (scripts/ops/tunnel-rate-rule.ts), and the
 * tunnel's run token written to a 0600 file for `cloudflared tunnel run
 * --token-file`. No `cloudflared tunnel login`, no cert.pem, no credentials
 * JSON. scripts/dev/preview-tunnel.sh calls it; it never prints a token.
 *
 *   bun scripts/ops/cf-tunnel.ts up --token-out ~/.config/lianki/preview-tunnel-token
 *   bun scripts/ops/cf-tunnel.ts down      # connections, tunnel, DNS record
 *   bun scripts/ops/cf-tunnel.ts status
 *   bun scripts/ops/cf-tunnel.ts check-secret <path>   # owner, 0600, not a symlink
 *   … --dry-run                            # read-only calls, then the plan
 *
 * The API token: CLOUDFLARE_API_TOKEN, else the file CF_API_TOKEN_FILE
 * (default ~/.config/lianki/cf-api-token: a regular file of this user,
 * mode 0600, not a symlink). It needs, on lianki.com and its account:
 *   Account · Cloudflare Tunnel · Edit
 *   Zone · DNS · Edit
 *   Zone · Zone WAF · Edit      (the http_ratelimit ruleset)
 *   Zone · Zone · Read          (finding the zone and its account)
 * Idempotent: the tunnel is found by name, the rule by ref, the record by name;
 * a DNS record is changed or deleted only if it points at a Cloudflare tunnel.
 * `down` leaves the rate-limiting rule: it is shared with the STT tunnel.
 */
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { PREVIEW_HOST, RULE_REF, rateRule } from "./tunnel-rate-rule";

export const TUNNEL_NAME = "lianki-preview";
export const HOST = PREVIEW_HOST;
export const ZONE = "lianki.com";
/** The guard's tunnel listener (scripts/dev/whole-page.ts serve --public-host: port + 4). */
export const ORIGIN = "http://127.0.0.1:3104";
export { RULE_REF, rateRule };
export type Env = { [k: string]: string | undefined };
export const DEFAULT_API_TOKEN_FILE = `${homedir()}/.config/lianki/cf-api-token`;

/** Only the gate is reachable through the tunnel; anything else is 404 at the connector. */
export function ingress() {
  return {
    config: { ingress: [{ hostname: HOST, service: ORIGIN }, { service: "http_status:404" }] },
  };
}

/** One API call: the result, undefined for a GET that 404s; throws with the API's message, never a token. */
export type Cf = <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
) => Promise<T | undefined>;

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

/** Why a secret file must not be used (symlink, not ours, not 0600), or null. Mirrors ticket.py. */
export function secretFileProblem(path: string, uid = process.getuid?.() ?? -1): string | null {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    return `cannot read (${(e as NodeJS.ErrnoException).code ?? "error"})`;
  }
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isFile()) return "is not a regular file";
  if (st.uid !== uid) return "is not owned by this user";
  if (st.mode & 0o077) return "is readable or writable by group or others (want 0600)";
  return null;
}

/** The API token: the env var, else the checked file. */
export function apiToken(env: Env = process.env): string {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN.trim();
  const path = env.CF_API_TOKEN_FILE || DEFAULT_API_TOKEN_FILE;
  const why = secretFileProblem(path);
  if (why) throw new Error(`no API token: set CLOUDFLARE_API_TOKEN, or ${path} ${why}`);
  const t = readFileSync(path, "utf8").trim();
  if (!t) throw new Error(`no API token: ${path} is empty`);
  return t;
}

/** Write a secret as a fresh 0600 file: an existing file or symlink is removed, never written through. */
export function writeSecretFile(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  writeFileSync(path, `${value}\n`, { mode: 0o600, flag: "wx" });
}

type Zone = { id: string; account: { id: string } };
type Tunnel = { id: string; name: string; config_src?: string; deleted_at?: string | null };
type Record = { id: string; type: string; name: string; content: string; proxied?: boolean };
type Ruleset = { id: string; rules?: { id: string; ref?: string }[] };

const isTunnelTarget = (c: string) => c.endsWith(".cfargotunnel.com");

export async function zoneOf(cf: Cf): Promise<Zone> {
  const zones = (await cf<Zone[]>("GET", `/zones?name=${ZONE}`)) ?? [];
  if (!zones[0]) throw new Error(`zone ${ZONE} not visible to this token`);
  return zones[0];
}

export async function findTunnel(cf: Cf, account: string): Promise<Tunnel | undefined> {
  const list =
    (await cf<Tunnel[]>(
      "GET",
      `/accounts/${account}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false`,
    )) ?? [];
  return list.find((t) => t.name === TUNNEL_NAME && !t.deleted_at);
}

export type Plan = string[];

/** Create or reuse everything; returns the plan (what was or would be done) and the run token. */
export async function up(
  cf: Cf,
  o: { dryRun?: boolean; account?: string } = {},
): Promise<{ plan: Plan; tunnelId?: string; token?: string }> {
  const plan: Plan = [];
  const zone = await zoneOf(cf);
  const account = o.account || zone.account.id;
  let t = await findTunnel(cf, account);
  if (t && t.config_src && t.config_src !== "cloudflare")
    throw new Error(
      `tunnel ${TUNNEL_NAME} exists but is locally managed (${t.config_src}): delete it first (scripts/dev/preview-tunnel.sh down)`,
    );
  // DNS: refuse before creating anything if the name is taken by something that is not a tunnel.
  const records = (await cf<Record[]>("GET", `/zones/${zone.id}/dns_records?name=${HOST}`)) ?? [];
  const foreign = records.filter((r) => !(r.type === "CNAME" && isTunnelTarget(r.content)));
  if (foreign.length)
    throw new Error(
      `${HOST} already has a ${foreign[0].type} record that is not a tunnel: not touching it`,
    );
  const rs = await cf<Ruleset>(
    "GET",
    `/zones/${zone.id}/rulesets/phases/http_ratelimit/entrypoint`,
  );
  const rule = rs?.rules?.find((r) => r.ref === RULE_REF);

  plan.push(t ? `reuse tunnel ${t.id}` : `create tunnel ${TUNNEL_NAME} (config_src cloudflare)`);
  plan.push(`set ingress: ${HOST} → ${ORIGIN}, else http_status:404`);
  const rec = records[0];
  plan.push(
    rec
      ? `point the ${HOST} CNAME at the tunnel (proxied)`
      : `create CNAME ${HOST} → <tunnel>.cfargotunnel.com (proxied)`,
  );
  plan.push(
    rule
      ? `update rate-limit rule ${rule.id}`
      : rs
        ? `add rate-limit rule to ruleset ${rs.id}`
        : "create the http_ratelimit entrypoint with the rule",
  );
  plan.push("fetch the tunnel's run token into the token file (0600)");
  if (o.dryRun) return { plan, tunnelId: t?.id };

  if (!t)
    t = await cf<Tunnel>("POST", `/accounts/${account}/cfd_tunnel`, {
      name: TUNNEL_NAME,
      config_src: "cloudflare",
    });
  if (!t?.id) throw new Error("tunnel create returned no id");
  await cf("PUT", `/accounts/${account}/cfd_tunnel/${t.id}/configurations`, ingress());
  const want = {
    type: "CNAME",
    name: HOST,
    content: `${t.id}.cfargotunnel.com`,
    proxied: true,
    comment: "lianki dev server tunnel (scripts/dev/preview-tunnel.sh)",
  };
  if (!rec) await cf("POST", `/zones/${zone.id}/dns_records`, want);
  else if (rec.content !== want.content || !rec.proxied)
    await cf("PATCH", `/zones/${zone.id}/dns_records/${rec.id}`, want);
  const base = `/zones/${zone.id}/rulesets`;
  if (rule && rs) await cf("PATCH", `${base}/${rs.id}/rules/${rule.id}`, rateRule());
  else if (rs) await cf("POST", `${base}/${rs.id}/rules`, rateRule());
  else await cf("PUT", `${base}/phases/http_ratelimit/entrypoint`, { rules: [rateRule()] });
  const token = await cf<string>("GET", `/accounts/${account}/cfd_tunnel/${t.id}/token`);
  if (typeof token !== "string" || !token) throw new Error("no run token from the API");
  return { plan, tunnelId: t.id, token };
}

/** The rollback: the tunnel's connections, the tunnel, its DNS record(s), the rule. */
export async function down(cf: Cf, o: { dryRun?: boolean; account?: string } = {}): Promise<Plan> {
  const plan: Plan = [];
  const zone = await zoneOf(cf);
  const account = o.account || zone.account.id;
  const t = await findTunnel(cf, account);
  const records = (await cf<Record[]>("GET", `/zones/${zone.id}/dns_records?name=${HOST}`)) ?? [];
  const tunnelRecs = records.filter((r) => r.type === "CNAME" && isTunnelTarget(r.content));
  plan.push(t ? `delete tunnel ${t.id} (connections first)` : "no tunnel");
  plan.push(
    tunnelRecs.length
      ? `delete ${tunnelRecs.length} tunnel record(s) for ${HOST}`
      : "no tunnel record",
  );
  if (records.length > tunnelRecs.length)
    plan.push(`leaving ${records.length - tunnelRecs.length} record(s) that are not a tunnel`);
  plan.push("leaving the rate-limiting rule (shared with the STT tunnel)");
  if (o.dryRun) return plan;
  if (t) {
    await cf("DELETE", `/accounts/${account}/cfd_tunnel/${t.id}/connections`);
    await cf("DELETE", `/accounts/${account}/cfd_tunnel/${t.id}`);
  }
  for (const r of tunnelRecs) await cf("DELETE", `/zones/${zone.id}/dns_records/${r.id}`);
  return plan;
}

export async function status(cf: Cf, account?: string): Promise<string[]> {
  const zone = await zoneOf(cf);
  const t = await findTunnel(cf, account || zone.account.id);
  const records = (await cf<Record[]>("GET", `/zones/${zone.id}/dns_records?name=${HOST}`)) ?? [];
  const rs = await cf<Ruleset>(
    "GET",
    `/zones/${zone.id}/rulesets/phases/http_ratelimit/entrypoint`,
  );
  return [
    `tunnel:       ${t ? `${t.id} (${t.config_src ?? "?"})` : "none"}`,
    `dns:          ${records.map((r) => `${r.type} → ${isTunnelTarget(r.content) ? "a tunnel" : "not a tunnel"}${r.proxied ? ", proxied" : ""}`).join("; ") || "none"}`,
    `rate limit:   ${rs?.rules?.some((r) => r.ref === RULE_REF) ? "on" : "none"}`,
  ];
}

export async function main(argv: string[], d: { cf?: Cf; env?: Env } = {}) {
  const env = d.env ?? process.env;
  const cmd = argv[0];
  const dryRun = argv.includes("--dry-run");
  const i = argv.indexOf("--token-out");
  const tokenOut = i >= 0 ? argv[i + 1] : undefined;
  if (cmd === "check-secret") {
    const why = argv[1] ? secretFileProblem(argv[1]) : "no path given";
    if (why) console.error(`${argv[1] ?? ""} ${why}`);
    return why ? 1 : 0;
  }
  const cf = d.cf ?? makeCf(apiToken(env));
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (cmd === "up") {
    if (!tokenOut && !dryRun) throw new Error("up needs --token-out <path>");
    const r = await up(cf, { dryRun, account });
    for (const p of r.plan) console.log(`${dryRun ? "plan" : "done"}: ${p}`);
    if (r.token && tokenOut) {
      writeSecretFile(tokenOut, r.token);
      console.log(`tunnel ${r.tunnelId}: run token written to ${tokenOut} (0600)`);
    }
    return 0;
  }
  if (cmd === "down") {
    for (const p of await down(cf, { dryRun, account }))
      console.log(`${dryRun ? "plan" : "done"}: ${p}`);
    return 0;
  }
  if (cmd === "status") {
    for (const l of await status(cf, account)) console.log(l);
    return 0;
  }
  console.error(
    "usage: cf-tunnel.ts up --token-out <path> | down | status | check-secret <path> [--dry-run]",
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`[cf-tunnel] ${(e as Error).message}`);
    process.exit(1);
  }
}
