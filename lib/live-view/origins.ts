/**
 * The exact origins live view may load JS from (docs/live-view.md, "What is
 * trusted"). A signed pointer to any other origin is refused — by the Mac's
 * script, the server and the page — so signing never delegates code to
 * whoever happens to serve some *.ts.net or *.lianki.com host.
 *
 * Exact origins: scheme, host and port. Add one only for a host the owner
 * runs (a named tunnel of his, e.g. "https://dev-mac.lianki.com"), by a
 * reviewed change here.
 */
/**
 * The exact origins a live-view pointer's `page` may name: where the
 * same-origin live preview (lib/live-view/page-proxy.ts) fetches whole pages
 * from. The gate in front of his dev server is there; the Worker enters it
 * with its own secret. A Cloudflare quick tunnel's random host
 * (`https://<words>.trycloudflare.com`) is also accepted, but only as a
 * signed pointer's `page` (LIVE_QUICK_TUNNEL in rules.ts), never for JS.
 */
export const LIVE_PAGE_ORIGINS: readonly string[] = ["https://preview.lianki.com"];

/**
 * The owner's own origins come from the build's environment, never from the
 * repository (public): NEXT_PUBLIC_LIANKI_LIVE_VIEW_ORIGINS, a comma-separated
 * list of exact origins — his Mac on his tailnet (tailscale serve, never
 * funnel), where the dev servers' `--tailnet /lianki-widget…` and
 * `/lianki-islands…` paths are. Unset: no live JS origin at all.
 */
const fromEnv = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
export const LIVE_VIEW_ORIGINS: readonly string[] = fromEnv(
  typeof process !== "undefined" ? process.env.NEXT_PUBLIC_LIANKI_LIVE_VIEW_ORIGINS : undefined,
);
