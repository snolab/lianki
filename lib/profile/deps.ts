import { headers } from "next/headers";
import { auth } from "@/auth";
import { authUserOrNull } from "@/app/signInEmail";
import { getBlobs, getD1 } from "@/lib/d1";
import type { AvatarBucket, ProfileDeps } from "./handlers";

/** The profile routes' dependencies: the session's user, better-auth's updateUser, D1, R2. */
export const profileDeps: ProfileDeps = {
  who: async () => {
    const u = await authUserOrNull();
    return u?.id ? { id: u.id, image: u.image ?? null } : null;
  },
  // Server-side only: the same endpoint is closed over HTTP (auth-impl.ts disabledPaths).
  update: async (fields) => {
    await auth.api.updateUser({ headers: await headers(), body: fields });
  },
  db: () => getD1(),
  bucket: () => getBlobs() as unknown as AvatarBucket,
};
