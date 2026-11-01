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
export const LIVE_VIEW_ORIGINS: readonly string[] = [
  // The owner's Mac on his tailnet (tailscale serve, never funnel): the dev servers'
  // `--tailnet /lianki-widget…` and `/lianki-islands…` paths.
  "https://taku.onca-tint.ts.net",
];
