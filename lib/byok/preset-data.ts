// Bring your own AI (docs/byok.md): the providers a user can pick, as data.
//
// Two halves, kept apart on purpose:
// - The **rows** (`ByokPresetRow`): name, protocol, base URL, a model to start
//   from, recommended models with a price tier, links, a one-line note. Their
//   defaults are `DEFAULT_PRESET_ROWS`; the live list is the config key
//   `byok.presets` (lib/config.ts), editable at /dev/config with no deploy, so
//   the owner can add a provider later. The settings render whatever it holds.
// - The **relay allowlist** (`RELAY_ALLOW`): which providers Lianki's relay
//   (`POST /api/byok/proxy`) may forward to. Code only, never config: adding a
//   host is an owner action, a reviewed change to this file. A row gets
//   `relay` only when its id is here AND its base URL is on the allowed host,
//   and the server checks against `RELAY_PRESETS` (code defaults) regardless.
//
// `browser`: checked with a throwaway invalid key from Origin
// https://lianki.com — a 401/400 that carries Access-Control-Allow-Origin
// means a page may call it; no CORS headers means server only (2026-11-05;
// DeepInfra, Groq, Workers AI 2026-11-15).
//
// No prices anywhere: they change, so a row links to the provider's pricing
// page and says only a tier (cheap / balanced / strong) per model.

import { z } from "zod";

/** A model name as providers write them ("gpt-4o-mini", "meta-llama/llama-3:8b", "@cf/meta/llama-3.1-8b-instruct"). */
export const MODEL_RE = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,119}$/;

export type ByokProtocol = "openai" | "anthropic";
export const MODEL_TIERS = ["cheap", "balanced", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface ByokModelPick {
  id: string;
  tier: ModelTier;
}

/** One provider as the config key holds it. */
export interface ByokPresetRow {
  /** Stable id, stored with the user's backend ("openrouter"). */
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
  /** The provider's own price list (we never show a price). */
  pricingUrl?: string;
  /** Where a user makes an API key. */
  keyUrl?: string;
  /** 2–4 models worth starting with, each with a price tier. */
  models?: ByokModelPick[];
  /**
   * The one-line description, by locale ("en", "zh"…), for a provider the
   * owner adds in config. The built-in ones are in the `byok-settings`
   * dictionary; a note here wins over it.
   */
  note?: Record<string, string>;
}

export interface ByokPreset extends ByokPresetRow {
  /**
   * Lianki's relay may forward to this provider: exactly this host, over https
   * on port 443, and only these paths. Only from `RELAY_ALLOW`, never config.
   */
  relay?: { host: string; paths: readonly string[] };
}

const HTTPS = /^https:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/;
const BASE =
  /^(https:\/\/[^\s/?#@]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?)(\/[^\s?#]*)?$/;
const link = z.string().max(300).regex(HTTPS, "an https:// link");

export const presetRowSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "a short lowercase id")
      .refine((id) => id !== "custom", "custom is built in"),
    name: z.string().trim().min(1).max(40),
    protocol: z.enum(["openai", "anthropic"]),
    baseUrl: z.string().max(300).regex(BASE, "https://…, or http://localhost"),
    model: z.string().regex(MODEL_RE, "a model name"),
    browser: z.boolean(),
    keyless: z.boolean().optional(),
    opaqueAuthErrors: z.boolean().optional(),
    policyUrl: link.optional(),
    pricingUrl: link.optional(),
    keyUrl: link.optional(),
    models: z
      .array(z.object({ id: z.string().regex(MODEL_RE), tier: z.enum(MODEL_TIERS) }).strict())
      .max(6)
      .optional(),
    note: z
      .record(
        z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
        z.string().trim().min(1).max(240),
      )
      .optional(),
  })
  .strict();

export const presetListSchema = z
  .array(presetRowSchema)
  .min(1)
  .max(30)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length, "ids must differ");

/** The built-in rows: the default of `byok.presets`. */
export const DEFAULT_PRESET_ROWS: ByokPresetRow[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    browser: true,
    opaqueAuthErrors: true,
    policyUrl: "https://openai.com/policies/row-privacy-policy/",
    pricingUrl: "https://openai.com/api/pricing/",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o-mini", tier: "cheap" },
      { id: "gpt-5-mini", tier: "balanced" },
      { id: "gpt-5.1", tier: "strong" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-haiku-4-5",
    browser: true,
    policyUrl: "https://www.anthropic.com/legal/privacy",
    pricingUrl: "https://www.anthropic.com/pricing",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-haiku-4-5", tier: "cheap" },
      { id: "claude-sonnet-4-5", tier: "balanced" },
      { id: "claude-opus-4-5", tier: "strong" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    browser: true,
    policyUrl: "https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html",
    pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", tier: "cheap" },
      { id: "deepseek-reasoner", tier: "strong" },
    ],
  },
  {
    id: "gemini",
    name: "Gemini",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    browser: true,
    policyUrl: "https://ai.google.dev/gemini-api/terms",
    pricingUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-flash-lite", tier: "cheap" },
      { id: "gemini-2.5-flash", tier: "balanced" },
      { id: "gemini-2.5-pro", tier: "strong" },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
    browser: true,
    policyUrl: "https://openrouter.ai/privacy",
    pricingUrl: "https://openrouter.ai/models",
    keyUrl: "https://openrouter.ai/settings/keys",
    models: [
      { id: "deepseek/deepseek-v4.1-flash", tier: "cheap" },
      { id: "openrouter/auto", tier: "balanced" },
      { id: "anthropic/claude-sonnet-4.5", tier: "strong" },
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    protocol: "openai",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    browser: true,
    policyUrl: "https://deepinfra.com/privacy",
    pricingUrl: "https://deepinfra.com/pricing",
    keyUrl: "https://deepinfra.com/dash/api_keys",
    models: [
      { id: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo", tier: "cheap" },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", tier: "balanced" },
      { id: "deepseek-ai/DeepSeek-V4-Pro", tier: "strong" },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    browser: true,
    policyUrl: "https://groq.com/privacy-policy",
    pricingUrl: "https://groq.com/pricing",
    keyUrl: "https://console.groq.com/keys",
    models: [
      { id: "llama-3.1-8b-instant", tier: "cheap" },
      { id: "llama-3.3-70b-versatile", tier: "balanced" },
      { id: "openai/gpt-oss-120b", tier: "strong" },
    ],
  },
  {
    // OpenAI-compatible endpoint (developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/);
    // ACCOUNT_ID is the user's own. api.cloudflare.com sends no CORS headers
    // (preflight 405, 2026-11-15), so a page cannot call it: server only.
    id: "workers-ai",
    name: "Workers AI",
    protocol: "openai",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    browser: false,
    policyUrl: "https://www.cloudflare.com/privacypolicy/",
    pricingUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    models: [
      { id: "@cf/meta/llama-3.1-8b-instruct", tier: "cheap" },
      { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", tier: "balanced" },
      { id: "@cf/openai/gpt-oss-120b", tier: "strong" },
    ],
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
];

/** The relay's allowlist, by preset id: code only (docs/byok.md, "The relay"). */
export const RELAY_ALLOW: Readonly<Record<string, { host: string; paths: readonly string[] }>> = {
  openai: { host: "api.openai.com", paths: ["/v1/chat/completions"] },
  anthropic: { host: "api.anthropic.com", paths: ["/v1/messages"] },
  deepseek: { host: "api.deepseek.com", paths: ["/chat/completions", "/v1/chat/completions"] },
  gemini: {
    host: "generativelanguage.googleapis.com",
    paths: ["/v1beta/openai/chat/completions"],
  },
  openrouter: { host: "openrouter.ai", paths: ["/api/v1/chat/completions"] },
};

/** Any OpenAI-compatible backend the user types in; always last, never relayed. */
export const CUSTOM_PRESET: ByokPreset = {
  id: "custom",
  name: "Custom",
  protocol: "openai",
  baseUrl: "",
  model: "",
  browser: true,
};

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The presets from the config rows: relay only from the code allowlist, Custom last. */
export function presetsFrom(rows: readonly ByokPresetRow[]): ByokPreset[] {
  const out: ByokPreset[] = rows.map((r) => {
    const { relay: _drop, ...row } = r as ByokPreset;
    const allow = RELAY_ALLOW[row.id];
    return allow && hostOf(row.baseUrl) === allow.host ? { ...row, relay: allow } : row;
  });
  return [...out, CUSTOM_PRESET];
}

/** The built-in presets (code defaults). */
export const BYOK_PRESETS: readonly ByokPreset[] = presetsFrom(DEFAULT_PRESET_ROWS);

/** The presets Lianki's relay may forward to (the allowlist, as data; server side). */
export const RELAY_PRESETS: readonly ByokPreset[] = BYOK_PRESETS.filter((p) => p.relay);

/** A relayable preset by id, from code only: what the relay server trusts. */
export const relayPresetOf = (id: string | null | undefined): ByokPreset | null =>
  RELAY_PRESETS.find((p) => p.id === id) ?? null;
