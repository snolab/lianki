/**
 * auth-impl.ts registers nextCookies(), and the real plugin imports next/headers,
 * so here it is a plugin that does nothing. It does more than serve server
 * actions: in a route handler it writes better-auth's Set-Cookie lines through
 * Next's cookies(). A ported route must forward them itself, by asking
 * getSession for `returnHeaders` (src/preferences.ts).
 */
export const nextCookies = () => ({ id: "next-cookies" as const });
