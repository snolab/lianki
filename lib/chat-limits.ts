/**
 * How often one API token may use the chat (`lianki chat`, POST
 * /api/version/chat), per kind of operation. Counted in D1 by
 * lib/chat-token.ts; also quoted, with these numbers, in the instructions a
 * user copies for their AI assistant (lib/agent-guide.ts). Its own module so
 * that client code can read the numbers without pulling in the D1 checks.
 */
const MIN = 60_000;

export type ChatLimit = { max: number; windowMs: number };

/** Per token, per kind of operation. */
export const CHAT_LIMITS: Record<"post" | "read" | "listen", ChatLimit> = {
  post: { max: 60, windowMs: 10 * MIN }, // say + ask
  read: { max: 240, windowMs: 10 * MIN },
  listen: { max: 30, windowMs: 10 * MIN },
};
