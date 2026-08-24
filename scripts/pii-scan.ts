#!/usr/bin/env bun
/**
 * PII / secret scanner.
 *
 * secretlint (pre-commit) covers known vendor credential formats. This adds the
 * personal-data categories it does not look for, and — importantly — can scan a
 * git range rather than the working tree, so content moving from a private repo
 * into this public one can be checked before it lands.
 *
 *   bun scripts/pii-scan.ts                      # tracked working-tree files
 *   bun scripts/pii-scan.ts path/a path/b        # specific paths
 *   bun scripts/pii-scan.ts --diff A..B          # only lines ADDED between A and B
 *   bun scripts/pii-scan.ts --ref REF            # every file as of REF
 *
 * Exit 1 if anything is found. Allowlist: scripts/pii-allowlist.txt (one literal
 * per line, # for comments).
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";

type Rule = { id: string; severity: "high" | "medium"; re: RegExp; check?: (m: string) => boolean };

const luhn = (digits: string) => {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
};

const PUBLIC_IP = (ip: string) => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return false;
  if (p[0] === 192 && p[1] === 168) return false;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
  if (p[0] === 169 && p[1] === 254) return false;
  if (p[0] >= 224) return false;
  return true;
};

const RULES: Rule[] = [
  { id: "private-key", severity: "high", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: "aws-access-key", severity: "high", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "github-token", severity: "high", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "openai-key", severity: "high", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "google-api-key", severity: "high", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "slack-token", severity: "high", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    id: "jwt",
    severity: "high",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  },
  {
    id: "db-uri-with-password",
    severity: "high",
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:/@]+:[^\s@]+@[^\s"'`]+/gi,
  },
  {
    id: "credit-card",
    severity: "high",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    check: (m) => luhn(m),
  },
  {
    id: "email",
    severity: "medium",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    check: (m) =>
      !/@(?:example|test|localhost|lianki\.test|sentry\.io)\b|\.(?:example|test|local)$/i.test(m),
  },
  {
    id: "public-ip",
    severity: "medium",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    check: PUBLIC_IP,
  },
  {
    id: "phone-e164",
    severity: "medium",
    re: /(?<![\w.-])\+\d{1,3}[ -]?(?:\(?\d{2,4}\)?[ -]?){2,4}\d{2,4}(?![\w.-])/g,
    check: (m) => m.replace(/\D/g, "").length >= 10,
  },
];

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const diffRange = flag("--diff");
const ref = flag("--ref");
const paths = args.filter((a) => !a.startsWith("--") && a !== diffRange && a !== ref);

const allowFile = "scripts/pii-allowlist.txt";
const allow = existsSync(allowFile)
  ? readFileSync(allowFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  : [];

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wasm|pdf|zip|gz|mp[34]|webm|apkg)$/i;
const SKIP_PATH =
  /(^|\/)(node_modules|\.next|\.open-next|\.git|bun\.lock|package-lock\.json)(\/|$)/;

type Finding = { file: string; line: number; rule: string; severity: string; sample: string };
const findings: Finding[] = [];

function redact(s: string) {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)} (${s.length} chars)`;
}

function scanText(file: string, text: string, lineOffset = (_i: number) => _i + 1) {
  text.split("\n").forEach((line, i) => {
    if (line.length > 4000) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        const hit = m[0];
        if (allow.some((a) => hit.includes(a))) continue;
        if (rule.check && !rule.check(hit)) continue;
        findings.push({
          file,
          line: lineOffset(i),
          rule: rule.id,
          severity: rule.severity,
          sample: redact(hit),
        });
      }
    }
  });
}

const sh = (cmd: string) => execSync(cmd, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });

if (diffRange) {
  // Only ADDED lines — that is the surface actually entering this repo.
  const diff = sh(`git diff --unified=0 ${diffRange}`);
  let file = "";
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (file && !BINARY.test(file) && !SKIP_PATH.test(file)) {
        scanText(file, raw.slice(1), () => lineNo);
      }
      lineNo++;
    }
  }
} else {
  const list = ref
    ? sh(`git ls-tree -r --name-only ${ref}`).split("\n")
    : paths.length
      ? paths.flatMap((p) =>
          statSync(p).isDirectory() ? sh(`git ls-files -- ${JSON.stringify(p)}`).split("\n") : [p],
        )
      : sh("git ls-files").split("\n");

  for (const f of list.filter(Boolean)) {
    if (BINARY.test(f) || SKIP_PATH.test(f)) continue;
    let text: string;
    try {
      text = ref ? sh(`git show ${ref}:${JSON.stringify(f)}`) : readFileSync(f, "utf8");
    } catch {
      continue;
    }
    scanText(f, text);
  }
}

const target = diffRange
  ? `added lines in ${diffRange}`
  : ref
    ? `files at ${ref}`
    : "tracked files";
if (!findings.length) {
  console.log(`pii-scan: clean — no PII or credentials in ${target}`);
  process.exit(0);
}

const high = findings.filter((f) => f.severity === "high");
console.error(`pii-scan: ${findings.length} finding(s) in ${target} (${high.length} high)\n`);
for (const sev of ["high", "medium"] as const) {
  const group = findings.filter((f) => f.severity === sev);
  if (!group.length) continue;
  console.error(`── ${sev.toUpperCase()} ──`);
  for (const f of group) console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.sample}`);
  console.error("");
}
console.error(`Allowlist false positives in ${allowFile}.`);
process.exit(1);
