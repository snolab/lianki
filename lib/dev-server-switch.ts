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

/**
 * The way in from the preview gate's page (docs/dev-whole-page.md, "Opening a
 * preview link directly"): a browser that lands on preview.lianki.com with no
 * session is sent to this owner-only page on lianki.com, which runs the same
 * switch (a fresh handoff, posted in a form body) and comes back to `to`.
 */
export const PREVIEW_ENTRY_PATH = "/dev/preview";

/** Anything that looks like a token or a handoff, or a parameter that carries one. */
const TOKENISH = /lk(dev|hand)_|(^|[?&;])(token|handoff)=/i;

function tokenish(s: string): boolean {
  if (TOKENISH.test(s)) return true;
  try {
    return TOKENISH.test(decodeURIComponent(s));
  } catch {
    return true; // undecodable: treat as suspect
  }
}

/**
 * `to` for the entry: a path (and query) on the preview origin, or null.
 * Relative only: no scheme, no host, no "//", no backslash or control
 * character (browsers drop TAB/LF/CR and read "\\" as "/"), and it must parse
 * back to the preview origin. The gate's own /_lk/ paths are refused. A query
 * that looks like it carries a token is dropped (the path is kept), so a
 * token can never travel in this URL. The #fragment is never kept.
 */
export function safePreviewPath(raw: string | null | undefined): string | null {
  const v = raw ?? "";
  if (!v || v.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(v, DEV_SERVER_ORIGIN);
  } catch {
    return null;
  }
  if (u.origin !== DEV_SERVER_ORIGIN) return null;
  const path = u.pathname;
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/_lk/")) return null;
  if (tokenish(path)) return null;
  const query = u.search && !tokenish(u.search) ? u.search : "";
  return `${path}${query}`;
}

/** The query parameter /sign-in reads for where to go after signing in. */
export const SIGN_IN_RETURN_PARAM = "next";

/**
 * Where /sign-in may send the browser after signing in, or null (then
 * "/home", as before). Only the preview entry on lianki.com, as a relative
 * path: anything else, any other origin, "//", backslash or control
 * character, is null. The result is rebuilt from its parts (`to` through
 * safePreviewPath), never echoed, so it is always "/dev/preview?to=…".
 */
export function signInReturnPath(raw: string | null | undefined): string | null {
  const v = raw ?? "";
  if (!v || v.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;
  if (!v.startsWith("/") || v.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(v, PROD_ORIGIN);
  } catch {
    return null;
  }
  if (u.origin !== PROD_ORIGIN || u.pathname !== PREVIEW_ENTRY_PATH) return null;
  const to = safePreviewPath(u.searchParams.get("to")) ?? "/";
  return `${PREVIEW_ENTRY_PATH}?to=${encodeURIComponent(to)}`;
}

/** /sign-in for a signed-out owner on the preview entry: back to it, same `to`, afterwards. */
export function signInUrlForPreview(to: string): string {
  const back = signInReturnPath(`${PREVIEW_ENTRY_PATH}?to=${encodeURIComponent(to)}`);
  return `/sign-in?${SIGN_IN_RETURN_PARAM}=${encodeURIComponent(back ?? PREVIEW_ENTRY_PATH)}`;
}

/** lianki.com's entry for a preview path: the switch, then back to that path on preview. */
export function previewEntryUrl(pathAndQuery: string): string {
  const to = safePreviewPath(pathAndQuery) ?? "/";
  return `${PROD_ORIGIN}${PREVIEW_ENTRY_PATH}?to=${encodeURIComponent(to)}`;
}
