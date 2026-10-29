/**
 * Who may open an owner debug socket (debug.ts). Kept out of index.ts: a
 * Worker's entry module may export only handlers and Durable Object classes.
 */
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** The only origin an owner debug page may connect from. */
export const DEBUG_ORIGIN = "https://lianki.com";

/**
 * Is this upgrade request the owner's, from a lianki.com page? The cookie is
 * checked by the main Worker itself (/api/dev/whoami → 200 only for the
 * owner), so lianki-push holds no secret and no copy of the owner list.
 */
export async function isOwnerSocket(req: Request, main: Fetcher | undefined): Promise<boolean> {
  if (req.headers.get("origin") !== DEBUG_ORIGIN) return false;
  const cookie = req.headers.get("cookie");
  if (!cookie || !main) return false;
  try {
    const res = await main.fetch(`${DEBUG_ORIGIN}/api/dev/whoami`, { headers: { cookie } });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { owner?: unknown };
    return body.owner === true;
  } catch {
    return false;
  }
}
