#!/usr/bin/env bun
/**
 * The edge side of the local STT tunnel (wss://stt.lianki.com,
 * docs/local-stt.md "Off the tailnet"): one rate-limiting rule on the
 * lianki.com zone, and on --remove, that rule plus the stt.lianki.com DNS
 * record. scripts/local-stt/tunnel.sh calls it from `up` and `down`.
 *
 *   bun scripts/ops/stt-edge.ts --dry-run   # the rule; read-only API calls if a token is set
 *   bun scripts/ops/stt-edge.ts             # add or update the rate-limiting rule
 *   bun scripts/ops/stt-edge.ts --remove    # delete the rule and the DNS record
 *
 * Env: CLOUDFLARE_API_TOKEN with Zone · DNS · Edit and Zone · Zone WAF · Edit
 * on lianki.com (the CI deploy token and wrangler's login have neither).
 *
 * Idempotent: the rule is found by its `ref`, the record by its name; a DNS
 * record is deleted only if it points at a Cloudflare tunnel.
 */

export const HOST = "stt.lianki.com";
export const ZONE = "lianki.com";
export const RULE_REF = "lianki_stt_handshakes";

/**
 * The Free plan's one rate-limiting rule: per IP (and colo), 10 s period and
 * 10 s block are the only values it allows. A page opens one socket per
 * race, so 10 handshakes in 10 s is far above the owner's use.
 */
export function rateRule(requests = 10) {
  return {
    ref: RULE_REF,
    description: "lianki-stt: handshakes to the local STT tunnel (docs/local-stt.md)",
    expression: `(http.host eq "${HOST}")`,
    action: "block",
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requests_per_period: requests,
      mitigation_timeout: 10,
    },
    enabled: true,
  };
}

type CfResult<T> = { success: boolean; result: T; errors?: { message: string }[] };

async function cf<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === "GET") return undefined;
  const data = (await res.json()) as CfResult<T>;
  if (!res.ok || !data.success)
    throw new Error(
      `${method} ${path}: ${res.status} ${data.errors?.map((e) => e.message).join("; ")}`,
    );
  return data.result;
}

type Ruleset = { id: string; rules?: { id: string; ref?: string }[] };

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const remove = argv.includes("--remove");
  const rule = rateRule();
  if (!remove) console.log(`Rule  ${JSON.stringify(rule, null, 2)}`);

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    if (dryRun) {
      console.log("\n(dry run, no CLOUDFLARE_API_TOKEN: nothing was read or written)");
      process.exit(0);
    }
    console.error(
      "Set CLOUDFLARE_API_TOKEN (Zone · DNS · Edit and Zone · Zone WAF · Edit on lianki.com).",
    );
    process.exit(2);
  }

  const zones = (await cf<{ id: string }[]>("GET", `/zones?name=${ZONE}`)) ?? [];
  const zone = zones[0]?.id;
  if (!zone) throw new Error(`zone ${ZONE} not visible to this token`);
  const phase = `/zones/${zone}/rulesets/phases/http_ratelimit/entrypoint`;
  const rs = await cf<Ruleset>("GET", phase);
  const existing = rs?.rules?.find((r) => r.ref === RULE_REF);

  if (remove) {
    const records =
      (await cf<{ id: string; type: string; content: string }[]>(
        "GET",
        `/zones/${zone}/dns_records?name=${HOST}`,
      )) ?? [];
    const tunnel = records.filter((r) => r.content.endsWith(".cfargotunnel.com"));
    const other = records.filter((r) => !r.content.endsWith(".cfargotunnel.com"));
    console.log(
      `Plan: ${existing ? `delete rule ${existing.id}` : "no rule"}, ` +
        `${tunnel.length ? `delete ${tunnel.length} tunnel record(s) for ${HOST}` : "no tunnel record"}` +
        (other.length ? `; leaving ${other.length} record(s) that are not a tunnel` : ""),
    );
    if (dryRun) process.exit(0);
    if (existing && rs) await cf("DELETE", `/zones/${zone}/rulesets/${rs.id}/rules/${existing.id}`);
    for (const r of tunnel) await cf("DELETE", `/zones/${zone}/dns_records/${r.id}`);
    console.log("✓ removed");
    process.exit(0);
  }

  console.log(
    `\nPlan: ${existing ? `update rule ${existing.id}` : rs ? `add a rule to ruleset ${rs.id}` : "create the ratelimit entrypoint"}`,
  );
  if (dryRun) process.exit(0);
  if (existing && rs)
    await cf("PATCH", `/zones/${zone}/rulesets/${rs.id}/rules/${existing.id}`, rule);
  else if (rs) await cf("POST", `/zones/${zone}/rulesets/${rs.id}/rules`, rule);
  else await cf("PUT", phase, { rules: [rule] });
  console.log("✓ rate limit in place");
}
