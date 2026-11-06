/**
 * The signed-in half of GET /api/preferences, behind one import() as auth.ts
 * does for better-auth, so a guest's request does not touch it.
 */
import { asWatchTracking, DEFAULT_REVIEW_ORDER } from "@lianki/core";
import { auth } from "@/auth";
import { getD1 } from "@/lib/d1";
import { PreferencesD1Repo } from "@/lib/repos/d1Repos";

/**
 * The route's JSON body (null when the session is not valid), and the session's
 * Set-Cookie lines: better-auth clears a bad cookie and rolls one due for a
 * refresh. Under Next the nextCookies plugin writes those; the wire contract
 * needs them here too, or the cookie's expiry stops following the session's.
 */
export async function getPreferencesFor(headers: Headers) {
  const { headers: out, response: session } = await auth.api.getSession({
    headers,
    returnHeaders: true,
  });
  const setCookies = out.getSetCookie();
  if (!session?.user) return { body: null, setCookies };
  const prefs = await new PreferencesD1Repo(getD1(), session.user.id).get();
  return {
    body: {
      mobileExcludePatterns: prefs?.mobileExcludePatterns ?? [],
      reviewOrder: prefs?.reviewOrder ?? DEFAULT_REVIEW_ORDER,
      watchTracking: asWatchTracking(prefs?.watchTracking),
    },
    setCookies,
  };
}
