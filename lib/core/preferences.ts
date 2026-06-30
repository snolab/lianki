// Framework-agnostic preference types. Extracted from app/api/preferences/route.ts
// (a Next route) so the D1 repos / CF-native worker can import them cleanly.
// The route re-exports these for back-compat.
export type FilterType = "domain" | "title" | "url";

export interface FilterPattern {
  id: string;
  type: FilterType;
  pattern: string;
  isRegex: boolean;
  enabled: boolean;
  createdAt: string;
}
