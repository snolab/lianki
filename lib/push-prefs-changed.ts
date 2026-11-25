import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * An account's settings changed from outside its pages (an agent's
 * `lianki_settings_set`, `lianki settings set`, the dev bridge): tell
 * lianki-push's DebugHub over the PUSH service binding, and that account's open
 * pages pull them at once (docs/prefs-sync.md, "When it syncs"). Only the user
 * id goes; the pages read the values with their own sign-in.
 *
 * Best effort, after the response (waitUntil): a page that missed it still
 * pulls when it is next shown. Never throws. Off the Worker (dev, QA) there is
 * no binding: nothing happens.
 */
type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };
export type PrefsNoticeDeps = { push: Fetcher | null; later: (p: Promise<unknown>) => void };

export const URL_PREFS_CHANGED = "https://lianki-push/internal/prefs-changed";

function deps(): PrefsNoticeDeps {
  try {
    const { env, ctx } = getCloudflareContext();
    return {
      push: (env as unknown as { PUSH?: Fetcher }).PUSH ?? null,
      later: (p) => ctx.waitUntil(p),
    };
  } catch {
    return { push: null, later: () => {} };
  }
}

export function notifyPrefsChanged(user: string, d: PrefsNoticeDeps = deps()) {
  const push = d.push;
  if (!push || !user) return;
  d.later(
    push
      .fetch(URL_PREFS_CHANGED, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user }),
      })
      .then((res) => {
        if (!res.ok) console.error(`[prefs] changed notice: lianki-push ${res.status}`);
      })
      .catch((e) => console.error("[prefs] changed notice:", e)),
  );
}
