/**
 * Config stt.ownerRoutes in the browser (lib/config.ts): the owner's default speech
 * route list, live, no deploy. Its own tiny module so the page (DebugEval) can set it
 * without loading local-stt.ts before the chat itself loads; local-stt.ts reads it in
 * ownerDefaultRoutes(). Empty = the build default (OWNER_DEFAULT_LOCAL_STT).
 */
let ownerRoutes = "";

/** Take the live value (DebugEval, from publicCfg). */
export function setOwnerRoutes(v: string | null | undefined): void {
  ownerRoutes = (v ?? "").trim();
}

/** The live value, "" when none is set. */
export const ownerRoutesOverride = (): string => ownerRoutes;
