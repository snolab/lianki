/**
 * lianki-voice's entry: only the handler may be exported from it (workerd
 * rejects any other named export). The logic, and why, is in ./clip.ts.
 */
import { handle, type Ctx, type EdgeCache, type Env } from "./clip";

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const cache = (globalThis as unknown as { caches: { default: EdgeCache } }).caches.default;
    return handle(req, env, ctx, cache);
  },
};
