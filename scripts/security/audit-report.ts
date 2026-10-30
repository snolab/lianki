#!/usr/bin/env bun
/**
 * Dependency vulnerability report (docs/security-measures.md, 脆弱性対策 ③).
 *
 *   bun scripts/security/audit-report.ts [--out reports/security] [--fail-on critical|high]
 *
 * Runs `bun audit --json` twice — production dependencies only (what can reach
 * the Worker) and everything (dev tooling too) — and writes:
 *
 * - `<out>/audit-prod.json`, `<out>/audit-all.json`: the raw advisories;
 * - `<out>/audit-summary.md`: counts per severity, then every production
 *   advisory at or above `--fail-on`, with its package and link. Also appended
 *   to the GitHub job summary when run in Actions.
 *
 * Exits 1 when a production dependency has an advisory at or above
 * `--fail-on` (default `critical`) that is not waived in
 * `security/audit-waivers.json` — a waiver needs a reason and an expiry date,
 * after which it stops counting.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  SEVERITIES,
  activeWaivers,
  blocking,
  counts,
  rank,
  type AuditJson,
  type Severity,
  type Waiver,
} from "@/lib/security/audit";

function audit(prod: boolean): AuditJson {
  const args = ["audit", "--json", ...(prod ? ["--prod"] : [])];
  const r = Bun.spawnSync(["bun", ...args], { stdout: "pipe", stderr: "pipe" });
  const text = r.stdout.toString().trim();
  if (!text) throw new Error(`bun ${args.join(" ")} printed nothing: ${r.stderr.toString()}`);
  return JSON.parse(text) as AuditJson;
}

{
  const argv = process.argv.slice(2);
  const opt = (name: string, dflt: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };
  const out = opt("--out", "reports/security");
  const failOn = opt("--fail-on", "critical") as Severity;
  if (rank(failOn) < 0) throw new Error(`--fail-on must be one of ${SEVERITIES.join(", ")}`);

  const waiverFile = "security/audit-waivers.json";
  const waivers: Waiver[] = existsSync(waiverFile)
    ? (JSON.parse(readFileSync(waiverFile, "utf8")) as Waiver[])
    : [];
  const waived = activeWaivers(waivers);

  const prodAudit = audit(true);
  const allAudit = audit(false);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "audit-prod.json"), JSON.stringify(prodAudit, null, 2));
  writeFileSync(join(out, "audit-all.json"), JSON.stringify(allAudit, null, 2));

  const pc = counts(prodAudit);
  const ac = counts(allAudit);
  const block = blocking(prodAudit, failOn, waived);
  const row = (c: Record<Severity, number>) => SEVERITIES.map((s) => c[s]).join(" | ");
  const md = [
    `## Dependency audit (${new Date().toISOString().slice(0, 10)})`,
    "",
    "| scope | low | moderate | high | critical |",
    "| --- | --- | --- | --- | --- |",
    `| production | ${row(pc)} |`,
    `| all (incl. dev tooling) | ${row(ac)} |`,
    "",
    block.length
      ? `### ${block.length} production advisories at ${failOn} or above (not waived)`
      : `No unwaived production advisory at ${failOn} or above.`,
    "",
    ...block.map(
      ({ pkg, a }) =>
        `- **${a.severity}** \`${pkg}\` ${a.vulnerable_versions}: ${a.title} — ${a.url}`,
    ),
    "",
  ].join("\n");
  writeFileSync(join(out, "audit-summary.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  process.exit(block.length ? 1 : 0);
}
