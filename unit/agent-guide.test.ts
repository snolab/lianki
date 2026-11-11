/**
 * The instructions a user copies for their own AI assistant (lib/agent-guide.ts):
 * sections follow the token's scopes, the header is the one the server reads,
 * the chat limits are the real ones, every locale fills every key, and the
 * token's secret never appears, whatever reaches the inputs.
 */
import { describe, expect, it } from "bun:test";
import dict from "@/lib/agent-guide.content";
import {
  GUIDE_KEYS,
  MCP_CLIENTS,
  TOKEN_PLACEHOLDER,
  agentGuide,
  guideStrings,
  withoutSecrets,
} from "@/lib/agent-guide";
import { SCOPE_IDS, newSecret, type ScopeId } from "@/lib/api-tokens";
import { CHAT_LIMITS } from "@/lib/chat-limits";

const LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
  "ko",
];
const en = guideStrings(dict.content, "en");
const guide = (scopes: ScopeId[], extra: { name?: string; expires?: string } = {}) =>
  agentGuide({ scopes, t: en, ...extra });

describe("agent guide: sections follow the token's scopes", () => {
  it("study only: cards, no chat", () => {
    const g = guide(["study"]);
    expect(g).toContain(`## ${en.cardsHeading}`);
    expect(g).toContain("GET /api/fsrs/due");
    expect(g).toContain("POST /api/fsrs/review/");
    expect(g).not.toContain(`## ${en.chatHeading}`);
    expect(g).not.toContain("/api/version/chat");
    expect(g).toContain(en.err404);
  });

  it("chat only: the chat ops it holds, no cards", () => {
    const g = guide(["chat:read", "chat:write"]);
    expect(g).toContain(`## ${en.chatHeading}`);
    expect(g).toContain(`"op": "read"`);
    expect(g).toContain(`"op": "say"`);
    expect(g).not.toContain(`"op": "ask"`);
    expect(g).not.toContain("/api/fsrs/");
    expect(g).not.toContain(en.err404);
  });

  it("lists exactly the permissions it holds", () => {
    const g = guide(["study", "chat:ask"]);
    expect(g).toContain("- `study`:");
    expect(g).toContain("- `chat:ask`:");
    for (const s of SCOPE_IDS.filter((x) => x !== "study" && x !== "chat:ask"))
      expect(g).not.toContain(`- \`${s}\`:`);
  });

  it("every guide has the token, limits, errors and safety sections", () => {
    for (const scopes of [["study"], ["chat:read"], ["eval"]] as ScopeId[][]) {
      const g = guide(scopes);
      for (const h of [
        "tokenHeading",
        "scopesHeading",
        "limitsHeading",
        "errorsHeading",
        "safetyHeading",
      ] as const)
        expect(g).toContain(`## ${en[h]}`);
      expect(g).toContain("https://lianki.com/my/preferences");
      expect(g).toContain("https://lianki.com/api/agent-guide");
    }
  });
});

describe("agent guide: what the server really takes", () => {
  it("the header is `Authorization: Bearer <token>`, with the placeholder", () => {
    const g = guide(["study", "chat:read"]);
    expect(g).toContain(`Authorization: Bearer ${TOKEN_PLACEHOLDER}`);
    // The form apiTokenUser and token-chat.ts accept: /^Bearer (lk_[0-9a-f]{64})$/
    const filled = g.replaceAll(TOKEN_PLACEHOLDER, newSecret());
    const line = filled.split("\n").find((l) => l.startsWith("Authorization: "))!;
    expect(/^Authorization: Bearer lk_[0-9a-f]{64}$/.test(line)).toBe(true);
  });

  it("quotes the chat limits from CHAT_LIMITS", () => {
    const g = guide(["chat:write"]);
    expect(g).toContain(String(CHAT_LIMITS.post.max));
    expect(g).toContain(String(CHAT_LIMITS.read.max));
    expect(g).toContain(String(CHAT_LIMITS.post.windowMs / 60_000));
    expect(guide(["study"])).not.toContain(String(CHAT_LIMITS.read.max));
  });

  it("names the token and its expiry when given", () => {
    const g = guide(["study"], { name: "My helper", expires: "7 December 2026" });
    expect(g).toContain("“My helper”");
    expect(g).toContain("7 December 2026");
  });
});

describe("agent guide: no secret in the prompt; the key lives where the AI runs", () => {
  it("every locale says how to get a key and where to keep it, and the MCP section", () => {
    for (const locale of LOCALES) {
      const t = guideStrings(dict.content, locale);
      const g = agentGuide({ scopes: ["study"], t });
      expect([locale, g.includes("npx lianki auth login")]).toEqual([locale, true]);
      expect([locale, g.includes("LIANKI_TOKEN")]).toEqual([locale, true]);
      expect([locale, g.includes("https://lianki.com/my/preferences")]).toEqual([locale, true]);
      expect(g).toContain(`## ${t.mcpHeading}`);
    }
  });

  it("has a working snippet for Claude Code, Claude Desktop, Cursor and Codex", () => {
    const g = guide(["chat:read"]);
    expect(g).toContain("claude mcp add lianki -- npx -y lianki mcp");
    for (const c of MCP_CLIENTS) expect(g).toContain(`${c.label}:\n\`\`\`${c.lang}\n${c.code}\n`);
    for (const c of MCP_CLIENTS.filter((x) => x.lang === "json")) {
      const cfg = JSON.parse(c.code.replaceAll(TOKEN_PLACEHOLDER, "x"));
      expect(cfg.mcpServers.lianki.command).toBe("npx");
      expect(cfg.mcpServers.lianki.args).toEqual(["-y", "lianki", "mcp"]);
    }
    const codex = MCP_CLIENTS.find((c) => c.label.startsWith("Codex"))!.code;
    expect(codex).toBe('[mcp_servers.lianki]\ncommand = "npx"\nargs = ["-y", "lianki", "mcp"]');
  });

  it("a token reaches the snippets only as the placeholder", () => {
    for (const c of MCP_CLIENTS) expect(/lk_[0-9a-f]{64}/i.test(c.code)).toBe(false);
  });
});

describe("agent guide: never the token", () => {
  it("contains no token-shaped secret for any scope set or locale", () => {
    for (const locale of LOCALES)
      for (const scopes of [
        ["study"],
        ["chat:read", "chat:write", "chat:ask"],
        [...SCOPE_IDS],
      ] as ScopeId[][]) {
        const g = agentGuide({ scopes, t: guideStrings(dict.content, locale), name: "x" });
        expect(/lk_[0-9a-f]{64}/i.test(g)).toBe(false);
        expect(g).toContain(TOKEN_PLACEHOLDER);
      }
  });

  it("a secret that reaches an input is replaced by the placeholder", () => {
    const secret = newSecret();
    const g = guide(["study"], { name: secret, expires: secret });
    expect(g).not.toContain(secret);
    expect(g).not.toContain(secret.slice(3));
    expect(withoutSecrets(`a ${secret} b`)).toBe(`a ${TOKEN_PLACEHOLDER} b`);
  });
});

describe("agent-guide dictionary", () => {
  it("has every key in all 16 locales, placeholders kept", () => {
    const content = dict.content as unknown as Record<
      string,
      { translation: Record<string, string> }
    >;
    expect(Object.keys(content).sort()).toEqual([...GUIDE_KEYS].sort());
    for (const k of GUIDE_KEYS) {
      const tr = content[k].translation;
      expect(Object.keys(tr).sort()).toEqual([...LOCALES].sort());
      const vars = (s: string) => (s.match(/\{\w+\}|<YOUR_TOKEN>/g) ?? []).sort();
      for (const l of LOCALES) {
        expect(tr[l].trim().length).toBeGreaterThan(0);
        expect([k, l, vars(tr[l])]).toEqual([k, l, vars(tr.en)]);
      }
    }
  });

  it("every locale fills every template field", () => {
    for (const l of LOCALES) {
      const g = agentGuide({
        scopes: [...SCOPE_IDS],
        t: guideStrings(dict.content, l),
        name: "n",
        expires: "d",
      });
      expect([l, g.match(/\{(base|name|date|post|read|minutes|url)\}/g)]).toEqual([l, null]);
    }
  });
});
