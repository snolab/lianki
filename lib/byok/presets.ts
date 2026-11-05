// Bring your own AI (docs/byok.md): the providers a user can pick, as data.
// Each preset says how to call it (`protocol`), where (`baseUrl`), a model to
// start from, and whether a browser may call it at all (`browser`: checked
// 2026-11-05 with a throwaway invalid key from Origin https://lianki.com —
// a 401/400 that carries Access-Control-Allow-Origin means a page may call
// it; no CORS headers means server only).
//
// Nothing here is per provider in code: a new preset is a new row.

/** A model name as providers write them ("gpt-4o-mini", "meta-llama/llama-3:8b"). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

export type ByokProtocol = "openai" | "anthropic";

export interface ByokPreset {
  id: string;
  /** The provider's own name; never translated. */
  name: string;
  protocol: ByokProtocol;
  /** Up to the path the protocol appends (`/chat/completions`, `/messages`). */
  baseUrl: string;
  /** A model to start from; the user may type any other. */
  model: string;
  /** The page may call it directly (CORS allows https://lianki.com). */
  browser: boolean;
  /** No key needed (a local server); any text in the key field is sent as is. */
  keyless?: boolean;
  /**
   * The provider answers a rejected key without CORS headers, so the browser
   * sees a network error instead of the 401 (OpenAI's chat endpoint). The
   * test explains it as "check the key" rather than "blocked by CORS".
   */
  opaqueAuthErrors?: boolean;
  /** Where its privacy / data-use policy is (shown with the notice). */
  policyUrl?: string;
  /**
   * Lianki's relay (`POST /api/byok/proxy`, docs/byok.md "The relay") may
   * forward to this provider: exactly this host, over https on port 443, and
   * only these paths. This is the relay's allowlist — a preset without it
   * (Ollama, Custom) is never relayed. Adding a host is an owner action: a
   * reviewed change to this file; users cannot add one.
   */
  relay?: { host: string; paths: readonly string[] };
}

export const BYOK_PRESETS: readonly ByokPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    browser: true,
    opaqueAuthErrors: true,
    policyUrl: "https://openai.com/policies/row-privacy-policy/",
    relay: { host: "api.openai.com", paths: ["/v1/chat/completions"] },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5",
    browser: true,
    policyUrl: "https://www.anthropic.com/legal/privacy",
    relay: { host: "api.anthropic.com", paths: ["/v1/messages"] },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    browser: true,
    policyUrl: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
    relay: { host: "api.deepseek.com", paths: ["/chat/completions", "/v1/chat/completions"] },
  },
  {
    id: "gemini",
    name: "Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    browser: true,
    policyUrl: "https://ai.google.dev/gemini-api/terms",
    relay: {
      host: "generativelanguage.googleapis.com",
      paths: ["/v1beta/openai/chat/completions"],
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
    browser: true,
    policyUrl: "https://openrouter.ai/privacy",
    relay: { host: "openrouter.ai", paths: ["/api/v1/chat/completions"] },
  },
  {
    id: "ollama",
    name: "Ollama",
    protocol: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.2",
    browser: true,
    keyless: true,
  },
  {
    id: "custom",
    name: "Custom",
    protocol: "openai",
    baseUrl: "",
    model: "",
    browser: true,
  },
];

/** The presets Lianki's relay may forward to (the allowlist, as data). */
export const RELAY_PRESETS: readonly ByokPreset[] = BYOK_PRESETS.filter((p) => p.relay);

export const presetOf = (id: string | null | undefined): ByokPreset | null =>
  BYOK_PRESETS.find((p) => p.id === id) ?? null;
