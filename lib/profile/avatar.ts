/**
 * Where an uploaded avatar lives and how it is addressed. Pure, so the browser
 * can use it too. The key and the URL hold only the user id and a random id,
 * never a file name, and a new upload gets a new id: the URL can be cached for
 * good and an old one simply stops existing.
 */
export const AVATAR_PREFIX = "avatars/";
const ROUTE = "/api/avatar/";

/** What is stored and served. No SVG (it can carry script), and no GIF: the browser sends a still. */
export const AVATAR_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/webp", "image/png"]);

export const isAvatarId = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{20}$/.test(v);
/** better-auth ids are [A-Za-z0-9]; anything else never reaches a key. */
export const isAvatarUser = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

export function newAvatarId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20);
}

export function avatarKey(userId: string, id: string): string {
  if (!isAvatarUser(userId) || !isAvatarId(id)) throw new Error("bad avatar key");
  return `${AVATAR_PREFIX}${userId}/${id}`;
}

export const avatarPath = (userId: string, id: string) => `${ROUTE}${userId}/${id}`;

/** Is this user.image an upload of ours (and not the sign-in provider's picture)? */
export const isOwnAvatar = (image: string | null | undefined) => !!image?.startsWith(ROUTE);

/** The centred square of a w×h picture, scaled to at most `side`; never scales up. */
export function squareCrop(w: number, h: number, side: number) {
  const crop = Math.min(w, h);
  return {
    sx: Math.floor((w - crop) / 2),
    sy: Math.floor((h - crop) / 2),
    crop,
    out: Math.min(crop, side),
  };
}

/** A picture's URL for a viewer on another origin (the chat hub wants an absolute https URL). */
export function absoluteImage(image: string | null | undefined, base: string): string {
  if (!image) return "";
  try {
    return new URL(image, base).href;
  } catch {
    return "";
  }
}
