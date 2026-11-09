import { getCloudflareContext } from "@opennextjs/cloudflare";
import { FINGERPRINTS_HEADER } from "./smart-refresh";

/**
 * Tell lianki-push (workers/push) which build this isolate serves, once per
 * isolate, without delaying the request. The first isolate of a new deploy
 * makes it news, and open pages whose code changed get "New version · Refresh"
 * pushed to them; later isolates of the same build change nothing.
 * Event-driven: no CI step, no secret, no timer. Off the Worker (dev, QA)
 * there is no binding and this does nothing.
 *
 * With the build go its route fingerprints (smart refresh, lib/smart-refresh.ts):
 * the static asset FINGERPRINTS_PATH that scripts/build/route-fingerprints.ts
 * wrote into this deploy, in the FINGERPRINTS_HEADER header. Without it (an
 * older build, a failed read) the build id goes alone, and every page asks to
 * refresh as before.
 */
let announced = false;

/** Where the deploy's fingerprints are served from (its own static assets). */
export const FINGERPRINTS_PATH = "/_lk/route-fp.json";

type Fetcher = { fetch(url: string, init?: RequestInit): Promise<Response> };

/** The publish request: the bare build id, plus its fingerprints when this deploy has them. */
export async function publishInit(
  build: string,
  assets: Fetcher | undefined,
): Promise<RequestInit> {
  const init: RequestInit = { method: "POST", body: build };
  try {
    const res = await assets?.fetch(`https://assets.local${FINGERPRINTS_PATH}`);
    if (res?.ok) {
      const fingerprints = (await res.json()) as { build?: unknown };
      if (fingerprints?.build === build)
        init.headers = { [FINGERPRINTS_HEADER]: encodeURIComponent(JSON.stringify(fingerprints)) };
    }
  } catch {}
  return init;
}

export function announceBuild(
  context: () => {
    env: unknown;
    ctx: { waitUntil(p: Promise<unknown>): void };
  } = getCloudflareContext,
) {
  if (announced) return;
  announced = true;
  try {
    const { env, ctx } = context();
    const { PUSH: push, ASSETS: assets } = env as unknown as { PUSH?: Fetcher; ASSETS?: Fetcher };
    if (!push) return;
    const build = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
    if (!build || build.startsWith("local-")) return;
    ctx.waitUntil(
      publishInit(build, assets)
        .then((init) => push.fetch("https://lianki-push/internal/publish", init))
        .catch(() => undefined),
    );
  } catch {
    // Not on the Worker.
  }
}
