import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Tell lianki-push (workers/push) which build this isolate serves, once per
 * isolate, without delaying the request. The first isolate of a new deploy
 * makes it news, and open pages get "New version · Refresh" pushed to them;
 * later isolates of the same build change nothing. Event-driven: no CI step,
 * no secret, no timer. Off the Worker (dev, QA) there is no binding and this
 * does nothing.
 */
let announced = false;

type Fetcher = { fetch(url: string, init: RequestInit): Promise<Response> };

export function announceBuild() {
  if (announced) return;
  announced = true;
  try {
    const { env, ctx } = getCloudflareContext();
    const push = (env as unknown as { PUSH?: Fetcher }).PUSH;
    if (!push) return;
    const build = process.env.NEXT_PUBLIC_BUILD_ID ?? "";
    if (!build || build.startsWith("local-")) return;
    ctx.waitUntil(
      push
        .fetch("https://lianki-push/internal/publish", { method: "POST", body: build })
        .catch(() => undefined),
    );
  } catch {
    // Not on the Worker.
  }
}
