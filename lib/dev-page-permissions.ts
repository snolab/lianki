/**
 * Which permission each /dev page checks (lib/permissions.ts), for the "who can
 * see this page" line the /dev layout adds (app/(app)/dev/layout.tsx). The page
 * itself holds the real gate; unit/permissions.test.ts checks that each page's
 * gate (isAdmin or isDev) matches this table, and that every page is listed.
 */
import type { Permission } from "./permissions";

export const DEV_PAGE_PERMISSION: Record<string, Permission> = {
  "box-clients": "admin",
  config: "admin",
  costs: "admin",
  credits: "admin",
  flags: "admin",
  friends: "admin",
  "gift-codes": "admin",
  membership: "admin",
  permissions: "admin",
  "stt-access": "admin",
  users: "admin",
  design: "dev",
  levels: "dev",
  lian: "dev",
  mails: "dev",
  "live-frontends": "dev",
  "new-order": "dev",
  preview: "dev",
  roadmap: "dev",
  session: "dev",
  "swipe-ab": "dev",
  templates: "dev",
  tokens: "dev",
};

/** The permission a /dev path's page checks, or null for an unknown path. */
export function devPagePermission(pathname: string): Permission | null {
  const m = /^\/dev\/([^/?#]+)/.exec(pathname);
  return (m && DEV_PAGE_PERMISSION[m[1]]) || null;
}
