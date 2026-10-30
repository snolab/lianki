/**
 * The rules behind scripts/security/check-public-dir.ts (see there): which
 * served files count as a leak.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** File names that must never be served. */
const FORBIDDEN_NAME = [
  /^\.env(\..*)?$/i, // .env, .env.local, .env.production …
  /^\.dev\.vars$/i,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer|der)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(sqlite|sqlite3|db|sql|dump|bak|backup|old|orig|swp)$/i,
  /\.(tar|tgz|gz|zip|7z|rar)$/i, // archives: a stray backup is the usual leak
  /^(wrangler\.(toml|jsonc?)|\.npmrc|\.netrc|\.htpasswd|credentials(\.json)?)$/i,
  /\.(log)$/i,
];

/** Paths (relative, `/`-separated) whose names alone mean server code. */
const SERVER_PATH = /(^|\/)(server|_worker\.js|middleware|api)(\/|\.|$)/i;

/** Contents that look like a credential (a narrow list; gitleaks does the broad scan). */
const SECRET_CONTENT: [string, RegExp][] = [
  ["private key", /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ["Stripe live/test secret", /\b(sk|rk)_(live|test)_[0-9a-zA-Z]{16,}/],
  ["Stripe webhook secret", /\bwhsec_[0-9a-zA-Z]{16,}/],
  ["PAY.JP secret", /\bsk_(live|test)_[0-9a-f]{24,}/],
  ["Resend API key", /\bre_[0-9a-zA-Z]{8,}_[0-9a-zA-Z]{16,}/],
  ["GitHub token", /\bgh[pousr]_[0-9a-zA-Z]{36,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abpors]-[0-9a-zA-Z-]{10,}/],
  [
    "env assignment of a secret",
    /^(AUTH_SECRET|[A-Z_]*_SECRET(_KEY)?|[A-Z_]*API_KEY)\s*=\s*\S{8,}/m,
  ],
];

/** Text-ish files are content-scanned; binaries only name-checked. */
const TEXT = /\.(js|mjs|cjs|json|html|htm|txt|md|css|svg|xml|map|ts|yaml|yml|env|ini|conf|cfg)$/i;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;

export interface Finding {
  file: string;
  reason: string;
}

export function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** Check one file, given its path relative to the served root and (for text) its content. */
export function checkFile(rel: string, content: string | null): Finding[] {
  const out: Finding[] = [];
  const name = rel.split("/").pop() ?? rel;
  for (const re of FORBIDDEN_NAME)
    if (re.test(name)) out.push({ file: rel, reason: `forbidden file type (${re.source})` });
  if (/\.map$/i.test(name)) {
    // Client source maps are a choice; a map of server code is a leak.
    if (SERVER_PATH.test(rel)) out.push({ file: rel, reason: "source map of server code" });
    else if (
      content &&
      /"sources"\s*:\s*\[[^\]]*(\/server\/|\/app\/api\/|auth-impl|\.server\.)/.test(content)
    )
      out.push({ file: rel, reason: "source map that includes server sources" });
  }
  if (content)
    for (const [label, re] of SECRET_CONTENT)
      if (re.test(content)) out.push({ file: rel, reason: `looks like a ${label}` });
  return out;
}

export function checkDir(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split("\\").join("/");
    const size = statSync(abs).size;
    const content = TEXT.test(abs) && size <= MAX_SCAN_BYTES ? readFileSync(abs, "utf8") : null;
    findings.push(...checkFile(rel, content));
  }
  return findings;
}
