import { getBlobs } from "@/lib/d1";
import { type AvatarBucket, getAvatar } from "@/lib/profile/handlers";

/** An uploaded avatar's bytes (lib/profile/handlers.ts). Loads no auth: a picture needs no session. */
export const GET = async (
  _req: Request,
  ctx: { params: Promise<{ user: string; id: string }> },
) => {
  const { user, id } = await ctx.params;
  return getAvatar(user, id, { bucket: () => getBlobs() as unknown as AvatarBucket });
};
