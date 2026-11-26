import { dohResolver, looksLikeIp, type Resolve } from "./byok/proxy-guard";
import { MAX_PROBE_REDIRECTS, type FetchLike } from "./probe";

/** A preflight is a hint, never permission to bypass the site's framing policy. */
export type PreviewPolicy = { allowed: boolean; url?: string };

function publicPage(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !url.hostname.includes(".") ||
      looksLikeIp(url.hostname) ||
      /(^|\.)(lianki\.com|localhost|local|internal|lan|home|corp|ts\.net)\.?$/i.test(url.hostname)
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** Conservative subset: unfamiliar CSP source expressions fall back to a link. */
function matchesAncestor(source: string, parent: URL, page: URL): boolean {
  if (source === "*") return true;
  if (source === "'self'") return parent.origin === page.origin;
  if (source === "https:") return parent.protocol === "https:";
  if (source === "http:") return parent.protocol === "http:";
  try {
    const allowed = new URL(source);
    return (
      !allowed.search &&
      !allowed.hash &&
      !allowed.username &&
      !allowed.password &&
      allowed.pathname === "/" &&
      allowed.origin === parent.origin
    );
  } catch {
    return false;
  }
}

export function headersAllowPreview(
  headers: Headers,
  pageUrl: string,
  parentOrigin: string,
): boolean {
  const page = new URL(pageUrl);
  const parent = new URL(parentOrigin);
  const policies = (headers.get("content-security-policy") ?? "").split(",");
  let hasAncestors = false;
  for (const policy of policies) {
    const directive = policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .find((d) => d[0]?.toLowerCase() === "frame-ancestors");
    if (!directive) continue;
    hasAncestors = true;
    if (!directive.slice(1).some((s) => matchesAncestor(s, parent, page))) return false;
  }
  // Enforced frame-ancestors replaces XFO. Report-only policies do not grant access.
  if (hasAncestors) return true;
  const xfo = headers.get("x-frame-options");
  if (!xfo) return true;
  return xfo.trim().toUpperCase() === "SAMEORIGIN" && page.origin === parent.origin;
}

/** HEAD only, no account cookies/headers, no body or page content returned. Each redirect is rechecked. */
export async function previewPolicy(
  rawUrl: string,
  parentOrigin: string,
  opts: { timeoutMs: number; fetchImpl?: FetchLike; resolve?: Resolve },
): Promise<PreviewPolicy> {
  const first = publicPage(rawUrl);
  if (!first) return { allowed: false };
  let at: URL = first;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const doFetch = opts.fetchImpl ?? fetch;
  const fetchForDns = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(url, { ...init, signal: controller.signal }),
    { preconnect: fetch.preconnect },
  );
  const resolve = opts.resolve ?? dohResolver(fetchForDns);
  try {
    for (let hop = 0; hop <= MAX_PROBE_REDIRECTS; hop++) {
      if (controller.signal.aborted || !(await resolve(at.hostname)).ok) return { allowed: false };
      const response = await doFetch(at.href, {
        method: "HEAD",
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html" },
      });
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { allowed: false };
        const next: URL | null = publicPage(new URL(location, at.href).href);
        if (!next) return { allowed: false };
        at = next;
        continue;
      }
      const html = /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(
        response.headers.get("content-type") ?? "",
      );
      return response.ok && html && headersAllowPreview(response.headers, at.href, parentOrigin)
        ? { allowed: true, url: at.href }
        : { allowed: false };
    }
    return { allowed: false };
  } catch {
    return { allowed: false };
  } finally {
    clearTimeout(timer);
  }
}
