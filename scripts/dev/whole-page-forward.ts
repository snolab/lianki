type Headers = Record<string, string | string[] | undefined>;

/**
 * Headers for next dev after the listener's device/session gate. The expected
 * browser origin comes from that listener's configuration, never forwarding
 * headers. Plain HTTP LAN traffic is represented as loopback upstream because
 * the app's production CSRF rule deliberately permits HTTP only on loopback.
 */
export function devForwardHeaders(
  h: Headers,
  browserOrigin: string,
  innerPort: number,
  authOrigin?: string,
): Headers {
  const browser = new URL(browserOrigin);
  if (typeof h.host !== "string" || h.host.toLowerCase() !== browser.host)
    throw new Error("unexpected dev request host");
  const localHttp =
    browser.protocol === "http:" &&
    browser.hostname !== "localhost" &&
    browser.hostname !== "127.0.0.1";
  const sameOrigin =
    h.origin === browser.origin &&
    (h["sec-fetch-site"] === undefined || h["sec-fetch-site"] === "same-origin");
  // Auth endpoints retain their configured Better Auth trusted origin. This
  // target is supplied only for the guard's two allowed auth routes.
  const target =
    sameOrigin && authOrigin
      ? new URL(authOrigin)
      : sameOrigin && localHttp
        ? new URL(`http://127.0.0.1:${innerPort}`)
        : browser;
  const out: Headers = {};
  for (const [key, value] of Object.entries(h)) {
    const k = key.toLowerCase();
    if (k === "forwarded" || k.startsWith("x-forwarded-")) continue;
    out[k] = value;
  }
  out.host = target.host;
  out["x-forwarded-host"] = target.host;
  out["x-forwarded-proto"] = target.protocol.slice(0, -1);
  out["x-forwarded-port"] = target.port || (target.protocol === "https:" ? "443" : "80");
  // Only an exact browser-origin match may be canonicalized. In particular,
  // an attacker naming the loopback target must not become same-origin.
  if (sameOrigin) out.origin = target.origin;
  else if (
    authOrigin ||
    h.origin !== undefined ||
    (h["sec-fetch-site"] !== undefined && h["sec-fetch-site"] !== "same-origin")
  )
    out.origin = "null";
  else delete out.origin;
  if (
    out.origin !== "null" &&
    typeof h.referer === "string" &&
    h.referer.startsWith(`${browser.origin}/`)
  )
    out.referer = target.origin + h.referer.slice(browser.origin.length);
  else delete out.referer;
  return out;
}
