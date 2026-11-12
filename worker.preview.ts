/** Preview has no zone route: forward its version sockets to its own push service. */
import app from "./worker";
export * from "./worker";

export default {
  ...app,
  async fetch(
    req: Request,
    env: Parameters<typeof app.fetch>[1] & { PUSH: { fetch(req: Request): Promise<Response> } },
    ctx: Parameters<typeof app.fetch>[2],
  ) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/version/")) {
      url.hostname = "lianki-push";
      return env.PUSH.fetch(new Request(url, req));
    }
    return app.fetch(req, env, ctx);
  },
};
