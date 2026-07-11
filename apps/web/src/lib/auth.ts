import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

// better-auth client — talks to the Worker's /api/auth/* handler (same origin).
// Email is the unique user identity; magic-link + GitHub/Google all resolve to
// the same account by email.
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  basePath: "/api/auth",
  plugins: [magicLinkClient()],
});
