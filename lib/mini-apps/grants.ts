/**
 * Per-(account, app, capability) permission logic (docs/mini-apps.md,
 * "Permissions"), as a browser does it per site: the first use prompts; the
 * user answers once / for this app / deny; "for this app" and "deny" stay
 * until revoked on /my/preferences; "once" covers exactly one call. Pure and
 * client-safe: the host page shows the same state the server enforces.
 */
import { type CapabilityId, isCapability } from "./capabilities";

export type Decision = "allow" | "deny" | "once";
export const CHOICES = ["once", "app", "deny"] as const;
export type Choice = (typeof CHOICES)[number];
export const isChoice = (v: unknown): v is Choice =>
  typeof v === "string" && (CHOICES as readonly string[]).includes(v);

export type GrantState = "granted" | "denied" | "prompt" | "undeclared";
export type Grants = Partial<Record<CapabilityId, Decision>>;

/** Where a capability stands for this app. */
export function grantState(declared: readonly string[], grants: Grants, cap: string): GrantState {
  if (!isCapability(cap) || !declared.includes(cap)) return "undeclared";
  const d = grants[cap];
  if (d === "allow" || d === "once") return "granted";
  if (d === "deny") return "denied";
  return "prompt";
}

/** What a prompt answer stores. */
export function decisionOf(choice: Choice): Decision {
  return choice === "app" ? "allow" : choice === "deny" ? "deny" : "once";
}

/** Rows as read from D1 → a grants map (unknown capabilities and decisions dropped). */
export function grantsOf(rows: readonly { permission: string; decision: string }[]): Grants {
  const out: Grants = {};
  for (const r of rows)
    if (isCapability(r.permission) && ["allow", "deny", "once"].includes(r.decision))
      out[r.permission] = r.decision as Decision;
  return out;
}
