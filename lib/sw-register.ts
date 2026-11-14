/**
 * Whether and how a page registers the site's service worker
 * (app/components/ServiceWorkerRegistration.tsx). One URL everywhere: on
 * lianki.com /sw.js is public/sw.js; on the whole-page dev server the same
 * path answers with the dev site's pass-through worker (lib/dev-site/pwa.ts),
 * chosen by the server, so the page never has to know which build it is.
 */
export const SW_URL = "/sw.js";
export const SW_SCOPE = "/";

export function serviceWorkerToRegister(
  nav: { serviceWorker?: unknown } | undefined,
  secureContext: boolean,
): { url: string; options: RegistrationOptions } | null {
  // Plain-http LAN pages have no service worker API (not a secure context).
  if (!secureContext || !nav || !("serviceWorker" in nav) || !nav.serviceWorker) return null;
  return { url: SW_URL, options: { scope: SW_SCOPE } };
}
