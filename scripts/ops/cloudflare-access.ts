#!/usr/bin/env bun
/**
 * Cloudflare Access in front of Lianki's admin surfaces — the IP/identity
 * layer of 脆弱性対策 ① (docs/security-measures.md, "Admin access").
 *
 *   bun scripts/ops/cloudflare-access.ts --dry-run   # print the plan; read-only API calls if a token is set
 *   bun scripts/ops/cloudflare-access.ts             # create or update the policy and the application
 *   bun scripts/ops/cloudflare-access.ts --verify    # check lianki.com/dev now redirects to Access
 *
 * Env: CLOUDFLARE_API_TOKEN (needs Account · Access: Apps and Policies · Edit;
 * the CI deploy token does not have it) and CLOUDFLARE_ACCOUNT_ID.
 * Options: --email a@b,c@d (default: OWNER_EMAILS from wrangler.jsonc),
 * --session 24h, --require-mfa (only if the identity provider reports MFA).
 *
 * Idempotent: the policy and the application are found by name and updated
 * in place, so running it twice changes nothing.
 *
 * The in-app gate (lib/owner.ts: every /dev page and /api/dev route answers
 * 404 to anyone but OWNER_EMAILS) stays; this is the layer in front of it.
 * Service-binding calls (lianki-push → /api/dev/whoami) do not pass through the
 * zone, so Access does not affect them.
 */
import { readFileSync } from "fs";

export const APP_NAME = "Lianki admin (/dev, /api/dev)";
export const POLICY_NAME = "Lianki owners";
/** Each path covers itself and everything below it. */
export const PROTECTED = ["lianki.com/dev", "lianki.com/api/dev"] as const;

export interface AccessOptions {
  emails: string[];
  sessionDuration: string;
  requireMfa: boolean;
}

export function policyBody(o: AccessOptions) {
  if (!o.emails.length) throw new Error("no owner emails: pass --email or set OWNER_EMAILS");
  return {
    name: POLICY_NAME,
    decision: "allow",
    include: o.emails.map((email) => ({ email: { email } })),
    ...(o.requireMfa ? { require: [{ auth_method: { auth_method: "mfa" } }] } : {}),
    session_duration: o.sessionDuration,
  };
}

export function appBody(o: AccessOptions, policyId: string) {
  return {
    name: APP_NAME,
    type: "self_hosted",
    domain: PROTECTED[0],
    destinations: PROTECTED.map((uri) => ({ type: "public", uri })),
    session_duration: o.sessionDuration,
    app_launcher_visible: false,
    auto_redirect_to_identity: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    policies: [{ id: policyId, precedence: 1 }],
  };
}

/** OWNER_EMAILS from wrangler.jsonc's vars (a comment-tolerant read). */
export function ownerEmailsFromWrangler(text: string): string[] {
  const m = text.match(/"OWNER_EMAILS"\s*:\s*"([^"]*)"/);
  return (m?.[1] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

type CfResult<T> = { success: boolean; result: T; errors?: { message: string }[] };

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as CfResult<T>;
  if (!res.ok || !data.success)
    throw new Error(
      `${method} ${path}: ${res.status} ${data.errors?.map((e) => e.message).join("; ")}`,
    );
  return data.result;
}

async function verify(): Promise<boolean> {
  let ok = true;
  for (const path of ["/dev/users", "/api/dev/whoami"]) {
    const res = await fetch(`https://lianki.com${path}`, { redirect: "manual" });
    const loc = res.headers.get("location") ?? "";
    const gated =
      (res.status === 302 || res.status === 403 || res.status === 401) &&
      (/cloudflareaccess\.com/.test(loc) || res.status !== 302);
    console.log(`${gated ? "✓" : "✗"} ${path}: ${res.status} ${loc.slice(0, 80)}`);
    ok &&= gated;
  }
  return ok;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (flag("--verify")) process.exit((await verify()) ? 0 : 1);

  const dryRun = flag("--dry-run");
  const emails = opt("--email")
    ? opt("--email")!
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    : ownerEmailsFromWrangler(readFileSync("wrangler.jsonc", "utf8"));
  const o: AccessOptions = {
    emails,
    sessionDuration: opt("--session") ?? "24h",
    requireMfa: flag("--require-mfa"),
  };
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const haveToken = Boolean(process.env.CLOUDFLARE_API_TOKEN && account);

  console.log(`Policy  ${JSON.stringify(policyBody(o), null, 2)}`);
  console.log(`App     ${JSON.stringify(appBody(o, "<policy id>"), null, 2)}`);

  if (!haveToken) {
    if (dryRun) {
      console.log(
        "\n(dry run, no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID: nothing was read or written)",
      );
      process.exit(0);
    }
    console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
    process.exit(2);
  }

  const base = `/accounts/${account}/access`;
  const policies = await cf<{ id: string; name: string }[]>("GET", `${base}/policies?per_page=100`);
  const apps = await cf<{ id: string; name: string }[]>("GET", `${base}/apps?per_page=100`);
  const existingPolicy = policies.find((p) => p.name === POLICY_NAME);
  const existingApp = apps.find((a) => a.name === APP_NAME);
  console.log(
    `\nPlan: ${existingPolicy ? `update policy ${existingPolicy.id}` : "create policy"}, ` +
      `${existingApp ? `update app ${existingApp.id}` : "create app"}`,
  );
  if (dryRun) {
    console.log("(dry run: nothing written)");
    process.exit(0);
  }

  const policy = existingPolicy
    ? await cf<{ id: string }>("PUT", `${base}/policies/${existingPolicy.id}`, policyBody(o))
    : await cf<{ id: string }>("POST", `${base}/policies`, policyBody(o));
  const app = existingApp
    ? await cf<{ id: string }>("PUT", `${base}/apps/${existingApp.id}`, appBody(o, policy.id))
    : await cf<{ id: string }>("POST", `${base}/apps`, appBody(o, policy.id));
  console.log(
    `✓ policy ${policy.id}, app ${app.id}. Now: bun scripts/ops/cloudflare-access.ts --verify`,
  );
}
