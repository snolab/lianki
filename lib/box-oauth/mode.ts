import type { BoxConfig } from "./client";
import { BOX_SCOPES } from "./rules";

/**
 * Is this server a box signing in through lianki.com? Set by the box's env file
 * (devbox/README.md), never on the deployed app. Then it has no sign-in or
 * sign-up of its own.
 */
export function boxConfig(): BoxConfig | null {
  const clientId = process.env.LIANKI_BOX_CLIENT_ID;
  if (!clientId) return null;
  return {
    clientId,
    ...(process.env.PREVIEW_MODE === "1" ? { sameOriginApi: true } : {}),
    provider: process.env.LIANKI_BOX_PROVIDER || "https://lianki.com",
    scope: process.env.LIANKI_BOX_SCOPE || BOX_SCOPES.join(" "),
    // The chat hub, when it is not the provider's /api/version/debug (local QA only).
    ...(process.env.LIANKI_BOX_HUB ? { hub: process.env.LIANKI_BOX_HUB } : {}),
  };
}
