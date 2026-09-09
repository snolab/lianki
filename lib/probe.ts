/**
 * Server-side reachability probe: is a card's page still answering?
 *
 * A retired site cannot be reviewed away from the browser. No content script
 * runs on a network-error page, so the card stays due, gets served again, and
 * the only escape is the dashboard.
 *
 * The check used to run in the browser through `GM_xmlhttpRequest`, and that was
 * the wrong place. Userscript managers gate cross-origin requests on `@connect`,
 * and a refused request reports through `onerror` exactly like a dead server —
 * so an install granting only lianki.com declared every host on earth dead. It
 * also cannot be fixed in place: `@connect` is fixed at install time, so a fix
 * shipped in the bundle does nothing until the user reinstalls the script.
 *
 * Asking the server sidesteps all of it. lianki.com is the one origin every
 * install must already be allowed to reach — it is where the cards come from —
 * so this works under any `@connect` list, in the Chrome extension, and on the
 * site itself, with one implementation to test.
 *
 * The tradeoff is that the server's view is not the user's. A site can be up for
 * them and refuse our egress, so the classifier below only reports `false` for
 * failures that are properties of the site rather than of who is asking.
 */

export type ProbeVerdict = {
  /** False only when the host demonstrably failed to answer anyone. */
  reachable: boolean;
  /** HTTP status, when there was a response at all. */
  status?: number;
  /** Url after redirects — a hint for renaming a moved card, never authoritative. */
  finalUrl?: string;
  /** Why we answered the way we did. Surfaced in /data, and useful in logs. */
  reason: "ok" | "unjudgeable" | "dns" | "tls" | "refused" | "timeout" | "network";
};

/**
 * Hosts we refuse to probe.
 *
 * The endpoint takes a url from the client and fetches it, which is a
 * server-side request forgery primitive. Authentication limits who can aim it,
 * and returning nothing but a status code limits what it can read, but neither
 * stops it being pointed at a private network. So loopback, link-local, cloud
 * metadata and RFC1918 addresses are refused outright.
 *
 * This is hostname matching, not resolution: a public name that resolves to
 * 127.0.0.1 still gets through. Closing that needs a resolve-then-pin fetch,
 * which the Workers runtime does not offer. The residual risk is a caller who
 * can already authenticate learning whether an internal port answers.
 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;

function isProbablePrivate(hostname: string): boolean {
  return (
    PRIVATE_HOST.test(hostname) || hostname.endsWith(".local") || hostname.endsWith(".internal")
  );
}

/**
 * Classify a fetch rejection.
 *
 * Only failures that would happen to anyone count as "the site is gone". A
 * connection refused or a timeout can equally mean the host dislikes datacenter
 * traffic, and calling those dead would silently drop cards that work fine in
 * the user's browser — a worse outcome than the stuck card this exists to
 * prevent. DNS and TLS failures are properties of the site itself.
 */
export function classifyProbeError(err: unknown): ProbeVerdict {
  const code = String(
    (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code ?? "",
  ).toUpperCase();
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();

  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || msg.includes("getaddrinfo")) {
    return { reachable: false, reason: "dns" };
  }
  // Matched loosely on purpose. Every runtime words this differently — Bun says
  // `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`, undici surfaces the OpenSSL code
  // as `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR` under `cause`, Workers throws
  // something else again — and a narrow match silently falls through to
  // "reachable", which is how the retired site that motivated all this stayed
  // undetected on the first attempt.
  if (/CERT|SSL|TLS|HANDSHAKE|EPROTO/.test(code) || /certificat|ssl|tls|handshake/.test(msg)) {
    return { reachable: false, reason: "tls" };
  }
  if (code === "ECONNREFUSED") return { reachable: true, reason: "refused" };
  if (code.includes("TIMEOUT") || msg.includes("timeout") || msg.includes("aborted")) {
    return { reachable: true, reason: "timeout" };
  }
  return { reachable: true, reason: "network" };
}

/** Narrower than `typeof fetch` so a test can pass a plain function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function probeReachability(
  rawUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<ProbeVerdict> {
  const doFetch = opts.fetchImpl ?? fetch;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { reachable: true, reason: "unjudgeable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { reachable: true, reason: "unjudgeable" };
  }
  if (isProbablePrivate(url.hostname)) return { reachable: true, reason: "unjudgeable" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  try {
    // GET, not HEAD: enough hosts answer HEAD with a 4xx or drop it outright
    // that a HEAD-only probe reports healthy pages as odd. The body is never
    // read, so the response is abandoned after the headers arrive.
    const res = await doFetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "lianki-reachability-probe" },
    });
    // Any HTTP status means something answered. 403 from a bot wall, 404 on a
    // page that still renders content — all reachable. Status is reported for
    // /data to show, never used to judge.
    return {
      reachable: true,
      status: res.status,
      finalUrl: res.url || url.toString(),
      reason: "ok",
    };
  } catch (err) {
    return classifyProbeError(err);
  } finally {
    clearTimeout(timer);
  }
}
