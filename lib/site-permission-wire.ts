/** Browser-safe schemas only. Parsing never grants a capability or changes chat authority. */
export const SITE_PERMISSION_SCOPE = "page.read" as const;
export const SITE_PERMISSION_MAX_BYTES = 65536;
export type SitePermissionScope = typeof SITE_PERMISSION_SCOPE;
export type SitePermissionManagementAction =
  | { op: "list" }
  | { op: "set"; origin: string; scope: SitePermissionScope; enabled: boolean }
  | { op: "inspect"; origin: string };
export type SitePermissionSelection = { text: string; title: string; url: string };
export type SitePermissionConsumeAction = {
  op: "consume";
  origin: string;
  scope: SitePermissionScope;
  revision: number;
  requestId: string;
  selection: SitePermissionSelection;
};
export type SitePermissionAuthorityAction =
  | SitePermissionManagementAction
  | SitePermissionConsumeAction;

/** Require the exact serialized origin: no path, normalization, wildcard or inferred subdomains. */
export function canonicalExactSiteOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200 || !raw.startsWith("https://")) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hostname.includes("*") &&
      url.origin === raw
      ? raw
      : null;
  } catch {
    return null;
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === "string" && keys.includes(key))
  );
};
/** First-party management schema. A browser consume request is deliberately not accepted here. */
export function parseSitePermissionManagementInput(
  value: unknown,
): SitePermissionManagementAction | null {
  try {
    if (!object(value)) return null;
    if (value.op === "list") return exactKeys(value, ["op"]) ? { op: "list" } : null;
    const origin = canonicalExactSiteOrigin(value.origin);
    if (!origin) return null;
    if (value.op === "inspect")
      return exactKeys(value, ["op", "origin"]) ? { op: "inspect", origin } : null;
    if (
      value.op === "set" &&
      exactKeys(value, ["op", "origin", "scope", "enabled"]) &&
      value.scope === SITE_PERMISSION_SCOPE &&
      typeof value.enabled === "boolean"
    )
      return { op: "set", origin, scope: SITE_PERMISSION_SCOPE, enabled: value.enabled };
    return null;
  } catch {
    return null;
  }
}
function parseSelection(value: unknown, origin: string): SitePermissionSelection | null {
  if (
    !object(value) ||
    !exactKeys(value, ["text", "title", "url"]) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 9000 ||
    typeof value.title !== "string" ||
    value.title.length > 300 ||
    typeof value.url !== "string" ||
    value.url.length > 2000 ||
    !value.url.startsWith("https://")
  )
    return null;
  const url = new URL(value.url);
  if (url.origin !== origin || url.username || url.password || /^https:\/\/[^/]*@/.test(value.url))
    return null;
  // Query strings and fragments may contain private identifiers; a selected page needs only its path.
  url.search = "";
  url.hash = "";
  return { text: value.text, title: value.title, url: url.href };
}
/** Narrow browser action schema. It cannot list, create, enable or otherwise manage permissions. */
export function parseSitePermissionConsumeInput(
  value: unknown,
): SitePermissionConsumeAction | null {
  try {
    if (
      !object(value) ||
      !exactKeys(value, ["op", "origin", "scope", "revision", "requestId", "selection"]) ||
      value.op !== "consume" ||
      value.scope !== SITE_PERMISSION_SCOPE ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 0 ||
      typeof value.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestId)
    )
      return null;
    const origin = canonicalExactSiteOrigin(value.origin);
    if (!origin) return null;
    const selection = parseSelection(value.selection, origin);
    return selection
      ? {
          op: "consume",
          origin,
          scope: SITE_PERMISSION_SCOPE,
          revision: value.revision as number,
          requestId: value.requestId,
          selection,
        }
      : null;
  } catch {
    return null;
  }
}
/** Only for the private authority boundary; public endpoints must use their separate parser. */
export function parseSitePermissionAuthorityAction(
  value: unknown,
): SitePermissionAuthorityAction | null {
  return parseSitePermissionManagementInput(value) ?? parseSitePermissionConsumeInput(value);
}
async function readInput<T>(
  request: Request,
  parse: (value: unknown) => T | null,
): Promise<T | "too-large" | null> {
  const claimed = request.headers.get("content-length");
  if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed) > SITE_PERMISSION_MAX_BYTES))
    return "too-large";
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SITE_PERMISSION_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
export const readSitePermissionManagementInput = (request: Request) =>
  readInput(request, parseSitePermissionManagementInput);
export const readSitePermissionConsumeInput = (request: Request) =>
  readInput(request, parseSitePermissionConsumeInput);

/** Stable internal signing names; management endpoints still use their narrower parser above. */
export type SitePermissionAction = SitePermissionAuthorityAction;
export type SiteReadAction = SitePermissionConsumeAction;
export const parseSitePermissionAction = parseSitePermissionAuthorityAction;
export const parseSiteReadAction = parseSitePermissionConsumeInput;
/** Private signed authority transport only; public routes keep the separate management/consume readers. */
export const readSitePermissionAuthorityInput = (request: Request) =>
  readInput(request, parseSitePermissionAction);

/** Public browser bridge: one exact site's read-only status or selected page text, never management. */
export type SitePageReadRequest = { op: "status"; origin: string } | SitePermissionConsumeAction;
export function parseSitePageReadRequest(value: unknown): SitePageReadRequest | null {
  try {
    if (object(value) && value.op === "status") {
      const origin = canonicalExactSiteOrigin(value.origin);
      return origin && exactKeys(value, ["op", "origin"]) ? { op: "status", origin } : null;
    }
    return parseSitePermissionConsumeInput(value);
  } catch {
    return null;
  }
}
export const readSitePageReadRequest = (request: Request) =>
  readInput(request, parseSitePageReadRequest);
