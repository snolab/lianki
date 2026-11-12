/** A separate deployment of lianki-push's version hub, with no production bindings. */
import { timingSafeEqual } from "node:crypto";
export { VersionHub } from "./index";

type PreviewEnv = {
  HUB: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  PREVIEW_PUBLISH_TOKEN?: string;
};

export default {
  async fetch(req: Request, env: PreviewEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/internal/publish" && req.method === "POST") {
      // Service binding calls use this internal host. Public calls must authenticate.
      if (url.hostname !== "lianki-push") {
        if (!env.PREVIEW_PUBLISH_TOKEN) return new Response("not configured", { status: 503 });
        const expected = new TextEncoder().encode(`Bearer ${env.PREVIEW_PUBLISH_TOKEN}`);
        const supplied = new TextEncoder().encode(req.headers.get("authorization") ?? "");
        if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
          return new Response("forbidden", { status: 403 });
      }
      return env.HUB.get(env.HUB.idFromName("version")).fetch(req);
    }
    if (url.pathname === "/api/version/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket only", { status: 426 });
      return env.HUB.get(env.HUB.idFromName("version")).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};
