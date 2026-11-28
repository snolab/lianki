import type { ReactNode } from "react";
import { authUserOrNull } from "@/app/signInEmail";
import { hasPermission, permissionHolders, type Permission } from "@/lib/permissions";

const PAGE_PERMISSIONS: readonly Permission[] = ["admin", "dev"];
import DevPageAccess from "./DevPageAccess";

/**
 * Every /dev page: the page renders (and gates itself), then a small "who can
 * see this page" line. The holders of a permission are passed only for the
 * permissions the viewer holds, so the line shows nothing to anyone else, not
 * even on a page's 404.
 */
export default async function DevLayout({ children }: { children: ReactNode }) {
  const user = await authUserOrNull();
  const holders: Partial<Record<Permission, string[]>> = {};
  // Only the permissions a /dev page checks: `insider` opens no /dev page, and
  // an insider must not be handed the list of the other insiders.
  for (const p of PAGE_PERMISSIONS)
    if (hasPermission(user?.email, p)) holders[p] = permissionHolders(p);
  return (
    <>
      {children}
      <DevPageAccess holders={holders} />
    </>
  );
}
