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
    provider: process.env.LIANKI_BOX_PROVIDER || "https://lianki.com",
    scope: process.env.LIANKI_BOX_SCOPE || BOX_SCOPES.join(" "),
  };
}
