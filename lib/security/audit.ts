/**
 * Pure helpers of scripts/security/audit-report.ts (see there): severities,
 * waivers, and which advisories block.
 */
export const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Advisory {
  id: number;
  url: string;
  title: string;
  severity: Severity;
  vulnerable_versions: string;
}
export type AuditJson = Record<string, Advisory[]>;

export interface Waiver {
  /** GHSA id, e.g. GHSA-xxxx-xxxx-xxxx. */
  ghsa: string;
  reason: string;
  /** ISO date; the waiver lapses after it. */
  until: string;
}

export const ghsaOf = (a: Pick<Advisory, "url">) => a.url.split("/").pop() ?? "";

export function rank(s: string): number {
  return SEVERITIES.indexOf(s as Severity);
}

export function activeWaivers(waivers: Waiver[], today = new Date()): Set<string> {
  const day = today.toISOString().slice(0, 10);
  return new Set(waivers.filter((w) => w.reason && w.until >= day).map((w) => w.ghsa));
}

export function counts(audit: AuditJson): Record<Severity, number> {
  const c = { low: 0, moderate: 0, high: 0, critical: 0 } as Record<Severity, number>;
  for (const list of Object.values(audit))
    for (const a of list) if (a.severity in c) c[a.severity]++;
  return c;
}

/** Advisories at or above `level`, not waived. */
export function blocking(audit: AuditJson, level: Severity, waived: Set<string>) {
  const out: { pkg: string; a: Advisory }[] = [];
  for (const [pkg, list] of Object.entries(audit))
    for (const a of list)
      if (rank(a.severity) >= rank(level) && !waived.has(ghsaOf(a))) out.push({ pkg, a });
  return out.sort((x, y) => rank(y.a.severity) - rank(x.a.severity) || x.pkg.localeCompare(y.pkg));
}
