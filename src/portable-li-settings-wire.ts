/** Browser-local settings bridge, accepted only on the top-level first-party settings page. */
export const PORTABLE_SETTINGS_REQUEST = "lianki:portable-settings-request";
export const PORTABLE_SETTINGS_STATE = "lianki:portable-settings-state";
export type PortableSettingsRequest =
  | { op: "state" | "allow" | "off" }
  | { op: "exclude"; host: string; excluded: boolean };
export type PortableSettingsState = {
  installed: true;
  consent: "unknown" | "all" | "off";
  excluded: string[];
  error?: true;
};
export function parsePortableSettingsRequest(detail: unknown): PortableSettingsRequest | null {
  if (typeof detail !== "string" || detail.length > 512) return null;
  try {
    const v = JSON.parse(detail);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (["state", "allow", "off"].includes(v.op) && Object.keys(v).length === 1)
      return { op: v.op };
    if (
      v.op === "exclude" &&
      Object.keys(v).length === 3 &&
      typeof v.host === "string" &&
      v.host.length <= 253 &&
      typeof v.excluded === "boolean"
    )
      return { op: "exclude", host: v.host, excluded: v.excluded };
  } catch {}
  return null;
}
