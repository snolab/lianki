/** Serialized, per-account page.read authority. Selection text is returned, never stored or logged. */
import {
  canonicalExactSiteOrigin,
  parseSitePermissionAction,
  SITE_PERMISSION_SCOPE,
  isSitePermissionScope,
  type SitePermissionScope,
  type SitePermissionAction,
  type SitePermissionSelection,
} from "./site-permission-wire";
export type SitePermissionGrant = {
  origin: string;
  scope: SitePermissionScope;
  enabled: boolean;
  revision: number;
};
export type SitePermissionReceipt = { jti: string; exp: number };
export type SitePermissionState = {
  revision: number;
  grants: SitePermissionGrant[];
  used: SitePermissionReceipt[];
};
export type SitePermissionAuthorityStorage = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: SitePermissionState): Promise<unknown>;
};
export type SitePermissionAuthorityResult =
  | { ok: true; kind: "list"; grants: SitePermissionGrant[] }
  | { ok: true; kind: "grant"; grant: SitePermissionGrant; accountBinding?: string }
  | { ok: true; kind: "selection"; selection: SitePermissionSelection; revision: number }
  | { ok: false; error: "invalid" | "replay" | "denied" | "busy" | "unavailable" };
const MAX_GRANTS = 128;
const MAX_USED = 1024;
const validRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const validJti = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Reconstruct fresh objects: storage adapters and returned results must not alias mutable authority state. */
function storedState(value: unknown): SitePermissionState | null {
  if (value === undefined) return { revision: 0, grants: [], used: [] };
  if (
    !object(value) ||
    !validRevision(value.revision) ||
    !Array.isArray(value.grants) ||
    value.grants.length > MAX_GRANTS ||
    !Array.isArray(value.used) ||
    value.used.length > MAX_USED
  )
    return null;
  const grants: SitePermissionGrant[] = [];
  const origins = new Set<string>();
  for (const entry of value.grants) {
    if (
      !object(entry) ||
      !canonicalExactSiteOrigin(entry.origin) ||
      !isSitePermissionScope(entry.scope) ||
      typeof entry.enabled !== "boolean" ||
      !validRevision(entry.revision) ||
      entry.revision === 0 ||
      entry.revision > value.revision ||
      origins.has(String(entry.origin) + "\n" + String(entry.scope))
    )
      return null;
    origins.add(String(entry.origin) + "\n" + String(entry.scope));
    grants.push({
      origin: entry.origin as string,
      scope: entry.scope,
      enabled: entry.enabled,
      revision: entry.revision,
    });
  }
  const used: SitePermissionReceipt[] = [];
  const ids = new Set<string>();
  for (const receipt of value.used) {
    if (
      !object(receipt) ||
      !validJti(receipt.jti) ||
      !Number.isSafeInteger(receipt.exp) ||
      Number(receipt.exp) < 0 ||
      ids.has(receipt.jti)
    )
      return null;
    ids.add(receipt.jti);
    used.push({ jti: receipt.jti, exp: receipt.exp as number });
  }
  return { revision: value.revision, grants, used };
}
export class SitePermissionAuthority {
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private readonly storage: SitePermissionAuthorityStorage,
    private readonly options: {
      now?: () => number;
      changed?: (sub: string, grant: SitePermissionGrant) => void;
    } = {},
  ) {}
  /** Internal, serialized action boundary. A read-only origin selector never grants private input. */
  withGrant<T>(
    sub: string,
    origin: string,
    scope: SitePermissionScope,
    revision: number | undefined,
    run: (grant: SitePermissionGrant) => T | Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: "denied" | "unavailable" }> {
    const result = this.pending.then(async () => {
      try {
        if (
          !/^[A-Za-z0-9_-]{1,64}$/.test(sub) ||
          !canonicalExactSiteOrigin(origin) ||
          !isSitePermissionScope(scope)
        )
          return { ok: false as const, error: "denied" as const };
        const state = storedState(await this.storage.get("siteperms:" + sub));
        if (!state) return { ok: false as const, error: "unavailable" as const };
        const granted = state.grants.find((g) => g.origin === origin && g.scope === scope);
        if (!granted?.enabled || (revision !== undefined && granted.revision !== revision))
          return { ok: false as const, error: "denied" as const };
        return { ok: true as const, value: await run({ ...granted }) };
      } catch {
        return { ok: false as const, error: "unavailable" as const };
      }
    });
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  execute(
    sub: string,
    action: SitePermissionAction,
    receipt: SitePermissionReceipt,
  ): Promise<SitePermissionAuthorityResult> {
    // Snapshot caller-owned inputs before waiting behind another operation.
    const input = parseSitePermissionAction(action);
    const proof = receipt && { jti: receipt.jti, exp: receipt.exp };
    const result = this.pending.then(() => this.apply(sub, input, proof));
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async apply(
    sub: string,
    action: SitePermissionAction | null,
    receipt: SitePermissionReceipt | null | undefined,
  ): Promise<SitePermissionAuthorityResult> {
    try {
      const time = (this.options.now ?? Date.now)();
      const now = Math.floor(time / 1000);
      if (
        !Number.isFinite(time) ||
        typeof sub !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(sub) ||
        !action ||
        !receipt ||
        !validJti(receipt.jti) ||
        !Number.isSafeInteger(receipt.exp) ||
        receipt.exp <= now ||
        receipt.exp > now + 60
      )
        return { ok: false, error: "invalid" };
      const key = "siteperms:" + sub;
      const state = storedState(await this.storage.get(key));
      if (!state) return { ok: false, error: "unavailable" };
      state.used = state.used.filter((entry) => entry.exp > now);
      if (state.used.some((entry) => entry.jti === receipt.jti))
        return { ok: false, error: "replay" };
      if (state.used.length >= MAX_USED) return { ok: false, error: "busy" };
      state.used.push({ ...receipt });
      let result: SitePermissionAuthorityResult;
      if (action.op === "list")
        result = { ok: true, kind: "list", grants: state.grants.map((grant) => ({ ...grant })) };
      else {
        const scope =
          action.op === "consume" ? SITE_PERMISSION_SCOPE : (action.scope ?? SITE_PERMISSION_SCOPE);
        const index = state.grants.findIndex(
          (grant) => grant.origin === action.origin && grant.scope === scope,
        );
        const grant = state.grants[index];
        if (action.op === "inspect")
          result = {
            ok: true,
            kind: "grant",
            grant: grant
              ? { ...grant }
              : {
                  origin: action.origin,
                  scope,
                  enabled: false,
                  revision: 0,
                },
          };
        else if (action.op === "set") {
          if (
            (!grant && state.grants.length >= MAX_GRANTS) ||
            state.revision === Number.MAX_SAFE_INTEGER
          )
            result = { ok: false, error: "busy" };
          else {
            state.revision++;
            const updated: SitePermissionGrant = {
              origin: action.origin,
              scope,
              enabled: action.enabled,
              revision: state.revision,
            };
            if (index < 0) state.grants.push(updated);
            else state.grants[index] = updated;
            result = { ok: true, kind: "grant", grant: { ...updated } };
          }
        } else if (!grant?.enabled || grant.revision !== action.revision)
          result = { ok: false, error: "denied" };
        else
          result = {
            ok: true,
            kind: "selection",
            selection: { ...action.selection },
            revision: grant.revision,
          };
      }
      // Single atomic put includes permission revisions and consumed receipt; never selection data.
      await this.storage.put(key, state);
      if (action.op === "set" && result.ok && result.kind === "grant")
        this.options.changed?.(sub, { ...result.grant });
      return result;
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }
}
