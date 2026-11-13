/**
 * The instructions a user copies for their own AI assistant, next to each API
 * token (Settings → API tokens, app/(app)/my/preferences/TokenManager.tsx),
 * and served publicly at GET /api/agent-guide (docs/api-for-agents.md).
 * Owner, 2026-11-10: many users have their own agents, so every token comes
 * with a prompt that teaches the agent how to use Lianki's API.
 *
 * One source: this function. The prose is the `agent-guide` dictionary
 * (lib/agent-guide.content.ts, 16 locales, each key with its context line);
 * the endpoints, headers and examples are code below, never translated, and
 * are the server's real ones:
 *
 * - the header is `Authorization: Bearer lk_…` (lib/authEmailOrToken.ts,
 *   lib/api-token-user.ts, workers/push/src/token-chat.ts);
 * - the card routes are app/fsrs.ts behind authEmailOrToken (scope `study`);
 * - the chat is POST /api/version/chat (token-chat.ts), limits CHAT_LIMITS.
 *
 * Sections follow the token's scopes: no chat section without a chat scope,
 * no card section without `study`.
 *
 * **Never the token.** The text names it only as TOKEN_PLACEHOLDER, and any
 * `lk_…` secret that reaches an input (a token named after its own secret) is
 * replaced by the placeholder before it is written. Owner, 2026-11-11: the
 * instructions hold no secret at all. They tell the user how to get a token
 * (`npx lianki auth login`, or Settings with only the permissions needed),
 * to keep it where the assistant runs (keychain, an environment variable, the
 * MCP config's `env` block) and never in a chat, and how to connect the local
 * `lianki mcp` server (packages/lianki-cli/mcp.mjs) or the remote one at
 * https://lianki.com/mcp (workers/mcp).
 */
import { CHAT_LIMITS } from "@/lib/chat-limits";
import { SCOPE_IDS, type ScopeId } from "@/lib/api-tokens";

export const GUIDE_BASE = "https://lianki.com";
export const GUIDE_PATH = "/api/agent-guide";
export const TOKEN_PLACEHOLDER = "<YOUR_TOKEN>";
const SETTINGS_URL = `${GUIDE_BASE}/my/preferences`;

/** The local MCP server in packages/lianki-cli (`lianki mcp`). */
export const MCP_ARGS = ["-y", "lianki", "mcp"];
const ARGS_JSON = JSON.stringify(MCP_ARGS).replaceAll(",", ", ");
/** The `mcpServers` config block, the args array kept on one line. */
const mcpServer = (env?: Record<string, string>) =>
  JSON.stringify(
    { mcpServers: { lianki: { command: "npx", args: 0, ...(env ? { env } : {}) } } },
    null,
    2,
  ).replace('"args": 0', `"args": ${ARGS_JSON}`);

/** How each MCP client adds the server: a label and a code block, never translated. */
export const MCP_CLIENTS: { label: string; lang: string; code: string }[] = [
  { label: "Claude Code", lang: "sh", code: `claude mcp add lianki -- npx ${MCP_ARGS.join(" ")}` },
  {
    label: "Claude Desktop (claude_desktop_config.json)",
    lang: "json",
    code: mcpServer({ LIANKI_TOKEN: TOKEN_PLACEHOLDER }),
  },
  { label: "Cursor (.cursor/mcp.json)", lang: "json", code: mcpServer() },
  {
    label: "Codex (~/.codex/config.toml)",
    lang: "toml",
    code: `[mcp_servers.lianki]\ncommand = "npx"\nargs = ${ARGS_JSON}`,
  },
];

/** The remote MCP server (workers/mcp, lianki-mcp): Streamable HTTP, the token as a bearer header. */
export const MCP_REMOTE_URL = `${GUIDE_BASE}/mcp`;
const BEARER = `Bearer ${TOKEN_PLACEHOLDER}`;
/** How a client connects to the remote server: a label and a code block, never translated. */
export const MCP_REMOTE_CLIENTS: { label: string; lang: string; code: string }[] = [
  {
    label: "Claude Code",
    lang: "sh",
    code: `claude mcp add --transport http lianki ${MCP_REMOTE_URL} --header "Authorization: ${BEARER}"`,
  },
  {
    label: "Cursor (.cursor/mcp.json)",
    lang: "json",
    code: JSON.stringify(
      { mcpServers: { lianki: { url: MCP_REMOTE_URL, headers: { Authorization: BEARER } } } },
      null,
      2,
    ),
  },
];

/** Every key of the `agent-guide` dictionary (its content is typed by this). */
export const GUIDE_KEYS = [
  "title",
  "intro",
  "tokenHeading",
  "tokenWhere",
  "tokenHeader",
  "tokenJson",
  "tokenNamed",
  "tokenExpires",
  "tokenGet",
  "tokenStore",
  "mcpHeading",
  "mcpIntro",
  "mcpEnv",
  "mcpRemote",
  "scopesHeading",
  "scopeStudy",
  "scopeChatRead",
  "scopeChatWrite",
  "scopeChatAsk",
  "scopeEval",
  "cannot",
  "cardsHeading",
  "cardsIntro",
  "epStats",
  "epDue",
  "epNext",
  "epAdd",
  "epReview",
  "epPrefs",
  "chatHeading",
  "chatIntro",
  "epRead",
  "epSay",
  "epAsk",
  "chatAnswer",
  "examplesHeading",
  "answers",
  "limitsHeading",
  "limitsGeneral",
  "limitsChat",
  "limits429",
  "errorsHeading",
  "err401",
  "err403",
  "err404",
  "err5xx",
  "safetyHeading",
  "safetySecret",
  "safetyAsk",
  "safetyRevoke",
  "latest",
  "pointer",
] as const;
export type GuideKey = (typeof GUIDE_KEYS)[number];
export type GuideStrings = Record<GuideKey, string>;

const SCOPE_LINE: Record<ScopeId, GuideKey> = {
  study: "scopeStudy",
  "chat:read": "scopeChatRead",
  "chat:write": "scopeChatWrite",
  "chat:ask": "scopeChatAsk",
  eval: "scopeEval",
};

/** Any API token secret in `s`, replaced by the placeholder. */
const SECRET_RE = /lk_[0-9a-f]{64}/gi;
export const withoutSecrets = (s: string) => s.replace(SECRET_RE, TOKEN_PLACEHOLDER);

/** `{name}`-style fields filled in. */
const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** A token name as one plain line (it is the user's own text), secrets out first. */
const plain = (s: string) =>
  withoutSecrets(s)
    .replace(/[\u0000-\u001f\u007f`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export type GuideInput = {
  /** What the token may do; only these sections are written. */
  scopes: readonly ScopeId[];
  /** The dictionary's strings in the user's language. */
  t: GuideStrings;
  /** The token's name, when the guide is for one token. */
  name?: string;
  /** When it stops working, already written as a date in the user's language. */
  expires?: string;
};

/** The instructions as Markdown, for the user to paste into their assistant. */
export function agentGuide({ scopes, t, name, expires }: GuideInput): string {
  const has = (s: ScopeId) => scopes.includes(s);
  const study = has("study");
  const chat = has("chat:read") || has("chat:write") || has("chat:ask");
  const H = `Authorization: Bearer ${TOKEN_PLACEHOLDER}`;
  const out: string[] = [];
  const p = (...lines: string[]) => out.push(...lines, "");

  p(`# ${t.title}`, "", t.intro);

  p(
    `## ${t.tokenHeading}`,
    t.tokenWhere,
    t.tokenHeader,
    "```",
    H,
    "```",
    fill(t.tokenJson, { base: GUIDE_BASE }),
  );
  const who = [
    name && plain(name) ? fill(t.tokenNamed, { name: plain(name) }) : "",
    expires ? fill(t.tokenExpires, { date: plain(expires) }) : "",
  ].filter(Boolean);
  if (who.length) p(who.join(" "));
  p(fill(t.tokenGet, { base: GUIDE_BASE, url: SETTINGS_URL }), "", t.tokenStore);

  p(
    `## ${t.mcpHeading}`,
    t.mcpIntro,
    "",
    ...MCP_CLIENTS.flatMap((c) => [`${c.label}:`, "```" + c.lang, c.code, "```", ""]),
    t.mcpEnv,
    "",
    t.mcpRemote,
    "",
    ...MCP_REMOTE_CLIENTS.flatMap((c) => [`${c.label}:`, "```" + c.lang, c.code, "```", ""]),
  );

  p(
    `## ${t.scopesHeading}`,
    ...SCOPE_IDS.filter(has).map((s) => `- \`${s}\`: ${t[SCOPE_LINE[s]]}`),
    "",
    t.cannot,
  );

  if (study) {
    p(
      `## ${t.cardsHeading}`,
      t.cardsIntro,
      "",
      `- \`GET /api/fsrs/stats\` → \`{"notes": 120, "due": 7}\`: ${t.epStats}`,
      `- \`GET /api/fsrs/due?limit=10\` → \`{"cards": [{"url", "title", "card": {"due", "state", "reps", "lapses"}}]}\`: ${t.epDue}`,
      `- \`GET /api/fsrs/next-url\` → \`{"url", "title"}\`: ${t.epNext}`,
      `- \`POST /api/fsrs/add\` \`{"url", "title"?}\` → \`{"url", "title", "card", "options"}\`: ${t.epAdd}`,
      `- \`POST /api/fsrs/review/{1|2|3|4}?url=…\` → \`{"ok", "due", "nextUrl", "nextTitle"}\`: ${t.epReview}`,
      `- \`GET /api/prefs\` → \`{"user", "prefs"}\`: ${t.epPrefs}`,
    );
  }

  if (chat) {
    const ops = [
      has("chat:read") &&
        `- \`{"op": "read", "limit": 30}\` → \`{"ok", "messages": [{"from", "text", "at"}]}\` (\`chat:read\`): ${t.epRead}`,
      has("chat:write") &&
        `- \`{"op": "say", "text": "…"}\` → \`{"ok", "id"}\` (\`chat:write\`): ${t.epSay}`,
      has("chat:ask") &&
        `- \`{"op": "ask", "question": "…", "options": [{"label": "…"}, {"label": "…"}]}\` → \`{"ok", "id", "askId"}\` (\`chat:ask\`): ${t.epAsk}`,
    ].filter((x): x is string => !!x);
    p(`## ${t.chatHeading}`, t.chatIntro, "", ...ops, "", t.chatAnswer);
  }

  if (study || chat) {
    const ex: string[] = [];
    if (study)
      ex.push(
        "```sh",
        `curl -H "${H}" ${GUIDE_BASE}/api/fsrs/due?limit=5`,
        "",
        `curl -X POST -H "${H}" -H "Content-Type: application/json" \\`,
        `  -d '{"url": "https://example.com/article", "title": "An article"}' \\`,
        `  ${GUIDE_BASE}/api/fsrs/add`,
        "```",
        "",
        "```http",
        "POST /api/fsrs/review/3?url=https%3A%2F%2Fexample.com%2Farticle HTTP/1.1",
        "Host: lianki.com",
        H,
        "```",
      );
    const chatOp = has("chat:read")
      ? `{"op": "read", "limit": 20}`
      : has("chat:write")
        ? `{"op": "say", "text": "Done: 5 cards reviewed."}`
        : has("chat:ask")
          ? `{"op": "ask", "question": "Add these 3 pages?", "options": [{"label": "Yes"}, {"label": "No"}]}`
          : "";
    if (chatOp)
      ex.push(
        ...(ex.length ? [""] : []),
        "```http",
        "POST /api/version/chat HTTP/1.1",
        "Host: lianki.com",
        H,
        "Content-Type: application/json",
        "",
        chatOp,
        "```",
      );
    p(`## ${t.examplesHeading}`, ...ex, "", t.answers);
  }

  const minutes = Math.round(CHAT_LIMITS.post.windowMs / 60_000);
  p(
    `## ${t.limitsHeading}`,
    `- ${t.limitsGeneral}`,
    ...(chat
      ? [
          `- ${fill(t.limitsChat, { post: CHAT_LIMITS.post.max, read: CHAT_LIMITS.read.max, minutes })}`,
        ]
      : []),
    `- ${t.limits429}`,
  );

  p(
    `## ${t.errorsHeading}`,
    `- ${t.err401}`,
    `- ${t.err403}`,
    ...(study ? [`- ${t.err404}`] : []),
    `- ${t.err5xx}`,
  );

  p(
    `## ${t.safetyHeading}`,
    `- ${fill(t.safetySecret, { base: GUIDE_BASE })}`,
    `- ${t.safetyAsk}`,
    `- ${fill(t.safetyRevoke, { url: SETTINGS_URL })}`,
  );

  out.push(fill(t.latest, { url: `${GUIDE_BASE}${GUIDE_PATH}` }));
  return withoutSecrets(out.join("\n").trim() + "\n");
}

/** One dictionary leaf as text: a string, an intlayer node, or a `t()` declaration in `locale`. */
export function guideText(v: unknown, locale = "en"): string {
  if (typeof v === "string") return v;
  const o = v as { value?: unknown; translation?: Record<string, string> } | null | undefined;
  if (o?.translation) return o.translation[locale] ?? o.translation.en ?? "";
  return String(o?.value ?? v ?? "");
}

/** The dictionary's strings, from `useIntlayer`/`getIntlayer` output or the declaration itself. */
export function guideStrings(content: unknown, locale = "en"): GuideStrings {
  const c = (content ?? {}) as Record<string, unknown>;
  return Object.fromEntries(GUIDE_KEYS.map((k) => [k, guideText(c[k], locale)])) as GuideStrings;
}

/**
 * The short message copied for the assistant (owner, 2026-11-14: the full text
 * was too long to copy): where the full instructions are, as a public file in
 * the user's language with this token's permissions, and where the token is
 * kept. Never the token.
 */
export function agentGuideUrl(scopes: readonly ScopeId[], lang: string): string {
  const base = `${GUIDE_BASE}/agent-guide.${encodeURIComponent(lang)}.md`;
  return scopes.length ? `${base}?scopes=${scopes.map(encodeURIComponent).join(",")}` : base;
}

export function agentGuidePointer({
  scopes,
  t,
  name,
  lang,
}: {
  scopes: readonly ScopeId[];
  t: GuideStrings;
  name: string;
  lang: string;
}): string {
  return fill(t.pointer, { url: agentGuideUrl(scopes, lang), name: plain(name) || "—" });
}
