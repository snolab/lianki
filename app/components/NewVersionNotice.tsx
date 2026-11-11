"use client";

import { usePathname } from "next/navigation";
import { VersionNotice } from "./VersionNotice";

/**
 * "New version · Refresh", only when a deploy changed the page you are on
 * (smart refresh: VersionNotice.tsx, lib/smart-refresh.ts). This wrapper hands
 * it Next's current path, so a soft navigation to a changed route shows it too.
 */
export function NewVersionNotice() {
  return <VersionNotice pathname={usePathname() ?? "/"} />;
}
