"use client";

import { usePathname } from "next/navigation";
import { useIntlayer } from "next-intlayer";
import { devPagePermission } from "@/lib/dev-page-permissions";
import type { Permission } from "@/lib/permissions";

/**
 * The small "who can see this page" line at the foot of a /dev page: the
 * addresses holding the permission this page checks (lib/dev-page-permissions.ts).
 * `holders` only carries the permissions the viewer holds (the layout decides),
 * so a viewer without the page's permission sees nothing.
 */
export default function DevPageAccess({
  holders,
}: {
  holders: Partial<Record<Permission, string[]>>;
}) {
  const c = useIntlayer("dev-permissions");
  const permission = devPagePermission(usePathname() ?? "");
  const list = permission ? holders[permission] : undefined;
  if (!permission || !list) return null;
  const name = permission === "admin" ? c.admin.value : c.dev.value;
  return (
    <footer className="max-w-6xl mx-auto px-4 pb-6 text-xs opacity-70 break-words">
      {c.whoCanSee.value.replace("{permission}", name)}{" "}
      <span className="font-mono">{list.join(", ")}</span>
      {holders.admin && (
        <>
          {" · "}
          <a href="/dev/permissions" className="underline">
            {c.manage}
          </a>
        </>
      )}
    </footer>
  );
}
