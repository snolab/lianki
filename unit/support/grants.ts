/**
 * Who holds what, for a test: every listed address gets the listed permissions
 * (both by default) in the isolate's snapshot (lib/permissions.ts). [] sets a
 * fresh snapshot in which nobody holds anything.
 */
import { PERMISSIONS, setPermissionSnapshot, type Permission } from "@/lib/permissions";

export function grantAll(
  emails: string[],
  permissions: readonly Permission[] = PERMISSIONS,
  at?: number,
): void {
  setPermissionSnapshot(
    emails.flatMap((email) => permissions.map((permission) => ({ email, permission }))),
    at,
  );
}

export { clearPermissionCache } from "@/lib/permissions";
