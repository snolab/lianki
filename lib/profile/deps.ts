import { headers } from "next/headers";
import { auth } from "@/auth";
import { authSessionOrNull, authUserOrNull } from "@/app/signInEmail";
import { getBlobs, getD1 } from "@/lib/d1";
import { isEmailConfigured } from "@/lib/email";
import { sendMail } from "@/lib/mail-log/deliver";
import type { EmailDb, EmailDeps } from "./email-change";
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

/** The address-change routes' dependencies (lib/profile/email-change.ts). */
export const emailDeps: EmailDeps = {
  who: async () => {
    const got = await authSessionOrNull();
    return got?.user?.id && got.user.email
      ? {
          id: got.user.id,
          email: got.user.email,
          sessionCreatedMs: new Date(got.session.createdAt).getTime(),
        }
      : null;
  },
  db: () => getD1() as unknown as EmailDb,
  send: sendMail,
  mailOn: isEmailConfigured,
  origin: () => process.env.BETTER_AUTH_BASE_URL ?? "https://lianki.com",
};
