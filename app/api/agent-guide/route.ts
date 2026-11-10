import { getIntlayer } from "intlayer";
import { OWNER_SCOPES, SCOPE_IDS, type ScopeId } from "@/lib/api-tokens";
import { agentGuide, guideStrings } from "@/lib/agent-guide";
import { localeFromAcceptLanguage } from "@/lib/app-locale";
import { isSupportedLocale } from "@/lib/constants";

/**
 * GET /api/agent-guide: the instructions for a user's AI assistant, as
 * Markdown (lib/agent-guide.ts, docs/api-for-agents.md). Public and the same
 * for everyone: no session, no token, nothing about any account.
 *
 *   ?scopes=study,chat:read   the sections to include (known permission ids;
 *                             default every permission but the owner's)
 *   ?lang=zh                  the language (else Accept-Language, else en)
 */
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const url = new URL(req.url);
  const asked = (url.searchParams.get("scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ScopeId => (SCOPE_IDS as readonly string[]).includes(s));
  const scopes = asked.length ? asked : SCOPE_IDS.filter((s) => !OWNER_SCOPES.includes(s));
  const lang = url.searchParams.get("lang");
  const locale =
    lang && isSupportedLocale(lang)
      ? lang
      : localeFromAcceptLanguage(req.headers.get("accept-language"));
  const t = guideStrings(getIntlayer("agent-guide", locale as never), locale);
  return new Response(agentGuide({ scopes, t }), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-language": locale,
      "cache-control": "public, max-age=3600",
      vary: "accept-language",
      "x-content-type-options": "nosniff",
    },
  });
}
