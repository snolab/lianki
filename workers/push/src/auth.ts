/**
 * Who may open a debug socket (debug.ts). Kept out of index.ts: a Worker's
 * entry module may export only handlers and Durable Object classes.
 */
import { type Identity, avatarUrl, isUserId } from "../../../lib/dev-eval";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** The only origin a debug page may connect from. */
export const DEBUG_ORIGIN = "https://lianki.com";

/**
 * Who is this upgrade request, from a lianki.com page? The cookie is checked
 * by the main Worker itself (/api/debug/identity → {userId, email, owner} for
 * any signed-in user, 401 for a guest), so lianki-push holds no secret and no
 * copy of the owner list. null = refuse.
 */
export async function debugIdentity(
  req: Request,
  main: Fetcher | undefined,
): Promise<Identity | null> {
  if (req.headers.get("origin") !== DEBUG_ORIGIN) return null;
  const cookie = req.headers.get("cookie");
  if (!cookie || !main) return null;
  try {
    const res = await main.fetch(`${DEBUG_ORIGIN}/api/debug/identity`, { headers: { cookie } });
    // A main Worker from before friends has no such route: ask the old
    // owner-only check, so deploying lianki-push first never locks the owner out.
    if (res.status === 404) return await ownerFallback(main, cookie);
    if (res.status !== 200) return null;
    const body = (await res.json()) as Partial<Record<keyof Identity, unknown>>;
    if (!isUserId(body.userId) || typeof body.email !== "string") return null;
    return {
      userId: body.userId,
      email: body.email,
      owner: body.owner === true,
      // For the chat's avatars; an older main Worker sends neither.
      ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
      ...(avatarUrl(body.image) ? { image: avatarUrl(body.image) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The pre-friends check: /api/dev/whoami answers 200 {owner:true} for the
 * owner only. That is the owner (whose user id and email it does not say, and
 * the hub does not need for the owner thread); anything else is refused.
 */
async function ownerFallback(main: Fetcher, cookie: string): Promise<Identity | null> {
  const res = await main.fetch(`${DEBUG_ORIGIN}/api/dev/whoami`, { headers: { cookie } });
  if (res.status !== 200) return null;
  const body = (await res.json()) as { owner?: unknown };
  return body.owner === true ? { userId: "owner", email: "", owner: true } : null;
}
