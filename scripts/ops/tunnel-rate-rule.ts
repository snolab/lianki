/**
 * The Free plan's one rate-limiting rule, shared by both of the owner's
 * tunnels: scripts/ops/stt-edge.ts (wss://stt.lianki.com) and
 * scripts/ops/cf-tunnel.ts (https://preview.lianki.com) write the same rule,
 * found by its ref. Per IP (and colo), 10 s period and 10 s block are the
 * only values the plan allows. A page opens one STT socket per race, and the
 * dev server's token handshake (/_lk/…) runs once per sign-in, so 10 in 10 s
 * is far above the owner's use; the dev server's pages and assets are not
 * counted.
 */
export const STT_HOST = "stt.lianki.com";
export const PREVIEW_HOST = "preview.lianki.com";
export const RULE_REF = "lianki_stt_handshakes";

export function rateRule(requests = 10) {
  return {
    ref: RULE_REF,
    description:
      "lianki tunnels: STT handshakes and dev-server token handshakes (docs/local-stt.md, docs/dev-whole-page.md)",
    expression: `(http.host eq "${STT_HOST}") or (http.host eq "${PREVIEW_HOST}" and starts_with(http.request.uri.path, "/_lk/"))`,
    action: "block",
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requests_per_period: requests,
      mitigation_timeout: 10,
    },
    enabled: true,
  };
}
