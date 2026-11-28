/** Rebuild the public result; private capability fields and unknown backend data never cross. */
import {
  canonicalExactSiteOrigin,
  SITE_PERMISSION_SCOPE,
  parseSiteReadAction,
} from "./site-permission-wire";
import type {
  SitePermissionGrant,
  SitePermissionAuthorityResult,
} from "./site-permission-authority";
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function grant(v: unknown): SitePermissionGrant | null {
  if (
    !object(v) ||
    !canonicalExactSiteOrigin(v.origin) ||
    v.scope !== SITE_PERMISSION_SCOPE ||
    typeof v.enabled !== "boolean" ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 0
  )
    return null;
  return {
    origin: v.origin as string,
    scope: SITE_PERMISSION_SCOPE,
    enabled: v.enabled,
    revision: v.revision as number,
  };
}
export function publicSitePermissionResult(v: unknown): SitePermissionAuthorityResult | null {
  if (!object(v)) return null;
  if (
    v.ok === false &&
    typeof v.error === "string" &&
    ["invalid", "replay", "denied", "busy", "unavailable"].includes(v.error)
  )
    return { ok: false, error: v.error as "invalid" };
  if (v.ok !== true) return null;
  if (v.kind === "list" && Array.isArray(v.grants) && v.grants.length <= 128) {
    const grants = v.grants.map(grant);
    return grants.every((x) => x !== null) ? { ok: true, kind: "list", grants } : null;
  }
  if (v.kind === "grant") {
    const g = grant(v.grant);
    if (
      v.accountBinding !== undefined &&
      (typeof v.accountBinding !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(v.accountBinding))
    )
      return null;
    return g
      ? {
          ok: true,
          kind: "grant",
          grant: g,
          ...(typeof v.accountBinding === "string" ? { accountBinding: v.accountBinding } : {}),
        }
      : null;
  }
  if (v.kind === "selection" && object(v.selection)) {
    let origin;
    try {
      origin = new URL(String(v.selection.url)).origin;
    } catch {
      return null;
    }
    const a = parseSiteReadAction({
      op: "consume",
      origin,
      scope: SITE_PERMISSION_SCOPE,
      revision: v.revision,
      requestId: "validated_result",
      selection: v.selection,
    });
    return a ? { ok: true, kind: "selection", selection: a.selection, revision: a.revision } : null;
  }
  return null;
}
