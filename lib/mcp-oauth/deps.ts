/**
 * The live I/O of lib/mcp-oauth/handlers.ts, for the app's routes. Server only.
 */
import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { notifyTokensRevoked } from "@/lib/push-chat-tokens";
import { clientIp, hit, type ThrottleDb } from "@/lib/security/throttle";
import type { OAuthDeps } from "./handlers";
import { MCP_OAUTH_FLAG } from "./rules";

export function oauthDeps(): OAuthDeps {
  const db = () => (dbBackend() === "d1" ? (getD1() as unknown as D1Like) : null);
  return {
    db,
    flagOn: async () => flagIn(await readFlags(), MCP_OAUTH_FLAG),
    limits: async () => ({
      accessMin: await cfg("mcp.oauthAccessMin"),
      refreshDays: await cfg("mcp.oauthRefreshDays"),
      codeSeconds: await cfg("mcp.oauthCodeSeconds"),
      registerPerHour: await cfg("mcp.oauthRegisterPerHour"),
      tokenPerMin: await cfg("mcp.oauthTokenPerMin"),
    }),
    allow: async (key, max, windowMs) => {
      const d = db();
      return d ? (await hit(d as unknown as ThrottleDb, key, { max, windowMs })).allowed : false;
    },
    user: async () => {
      const u = await authUserOrNull();
      return u?.id && u.email ? { id: u.id, email: u.email } : null;
    },
    revoked: (ids) => notifyTokensRevoked({ ids }).catch(() => {}),
    ip: (req) => clientIp(req.headers),
    now: () => Date.now(),
  };
}
