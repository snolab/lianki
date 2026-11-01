/**
 * The owner's switch between lianki.com and his whole-page dev server on its
 * tunnel (docs/dev-whole-page.md, "The profile menu switch").
 *
 * - Shown only to the owner, decided on the server (devSwitchMode, from the
 *   session's email and the process): no one else's page carries it.
 * - Up or down is checked once, when the menu opens (one fetch to the gate's
 *   /_lk/up, which answers 503 with its marker: nothing there is a way in).
 *   No polling, no timers left running.
 * - Tapping it mints a single-use, 60 s handoff (POST /api/dev/dev-handoff)
 *   and posts it to the dev server in a form body: never in a URL, so never
 *   in history, a Referer or a log. Same path and query on the other side.
 * - On the dev server the same spot reads "Back to lianki.com": a plain link
 *   to the same path on production.
 */

export const DEV_SERVER_ORIGIN = "https://preview.lianki.com";
export const PROD_ORIGIN = "https://lianki.com";
export const UP_TIMEOUT_MS = 1500;

export type DevSwitchMode = "go" | "back" | null;

/** Server side: "go" on lianki.com for the owner, "back" on the dev server, null for everyone else. */
export function devSwitchMode(o: { owner: boolean; devServer: boolean }): DevSwitchMode {
  if (!o.owner) return null;
  return o.devServer ? "back" : "go";
}

/** The same page on production. */
export function backUrl(loc: { pathname: string; search: string }): string {
  return `${PROD_ORIGIN}${loc.pathname}${loc.search}`;
}

/** One check: is the dev server's gate answering? (Its 503 with the marker header means yes.) */
export async function devServerUp(
  f: typeof fetch = fetch,
  timeoutMs = UP_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const r = await f(`${DEV_SERVER_ORIGIN}/_lk/up`, {
      mode: "cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.headers.get("x-lianki-gate") === "1";
  } catch {
    return false;
  }
}

/** Post a token or handoff to the dev server's handshake as a form: the browser navigates there. */
export function postToDevServer(token: string, next: string, doc: Document = document): void {
  const form = doc.createElement("form");
  form.method = "POST";
  form.action = `${DEV_SERVER_ORIGIN}/_lk/dev-auth`;
  form.referrerPolicy = "no-referrer";
  form.style.display = "none";
  for (const [name, value] of [
    [token.startsWith("lkhand_") ? "handoff" : "token", token],
    ["next", next],
  ]) {
    const i = doc.createElement("input");
    i.type = "hidden";
    i.name = name;
    i.value = value;
    form.appendChild(i);
  }
  doc.body.appendChild(form);
  form.submit();
  form.remove();
}

/** Tap: a fresh handoff from lianki.com, then the jump with the same path and query. */
export async function switchToDevServer(
  loc: { pathname: string; search: string },
  d: { fetch?: typeof fetch; post?: (token: string, next: string) => void } = {},
): Promise<boolean> {
  const f = d.fetch ?? fetch;
  const r = await f("/api/dev/dev-handoff", { method: "POST", cache: "no-store" });
  if (!r.ok) return false;
  const { handoff } = (await r.json()) as { handoff?: string };
  if (!handoff) return false;
  (d.post ?? postToDevServer)(handoff, `${loc.pathname}${loc.search}`);
  return true;
}
