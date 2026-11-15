// BYOK provider presets as data (lib/byok/preset-data.ts, lib/byok/presets.ts,
// the config key `byok.presets`; docs/byok.md "Presets"): the rows' shape,
// prices never baked in, the relay allowlist only from code, and the live
// list read from the public config.
import { afterEach, describe, expect, it } from "bun:test";
import { CONFIG, parseConfigValue } from "@/lib/config";
import { setPublicConfig } from "@/lib/config-client";
import {
  BYOK_PRESETS,
  CUSTOM_PRESET,
  DEFAULT_PRESET_ROWS,
  MODEL_RE,
  RELAY_ALLOW,
  RELAY_PRESETS,
  presetListSchema,
  presetRowSchema,
  presetsFrom,
  relayPresetOf,
  type ByokPresetRow,
} from "@/lib/byok/preset-data";
import { livePresets, presetOf, rowNote } from "@/lib/byok/presets";
import { checkBackend } from "@/lib/byok/proxy-guard";

afterEach(() => setPublicConfig(null));

const row = (over: Partial<ByokPresetRow> = {}): ByokPresetRow => ({
  id: "acme",
  name: "Acme AI",
  protocol: "openai",
  baseUrl: "https://api.acme.example/v1",
  model: "acme-small",
  browser: true,
  ...over,
});

describe("default rows", () => {
  it("are the config key's default, and it validates", () => {
    expect(CONFIG["byok.presets"].default).toBe(DEFAULT_PRESET_ROWS);
    expect(CONFIG["byok.presets"].audience).toBe("public");
    expect(parseConfigValue("byok.presets", DEFAULT_PRESET_ROWS).ok).toBe(true);
  });

  it("offer the owner's providers, Custom last", () => {
    expect(BYOK_PRESETS.map((p) => p.id)).toEqual([
      "openai",
      "anthropic",
      "deepseek",
      "gemini",
      "openrouter",
      "deepinfra",
      "groq",
      "workers-ai",
      "ollama",
      "custom",
    ]);
    expect(BYOK_PRESETS.at(-1)).toBe(CUSTOM_PRESET);
  });

  it("each hosted row has 2–4 recommended models with a tier, pricing and key links, no price", () => {
    for (const r of DEFAULT_PRESET_ROWS) {
      expect(presetRowSchema.safeParse(r).success).toBe(true);
      expect(MODEL_RE.test(r.model)).toBe(true);
      if (r.keyless) continue;
      expect(r.models!.length).toBeGreaterThanOrEqual(2);
      expect(r.models!.length).toBeLessThanOrEqual(4);
      expect(r.models!.map((m) => m.id)).toContain(r.model);
      expect(r.pricingUrl).toMatch(/^https:\/\//);
      expect(r.keyUrl).toMatch(/^https:\/\//);
      // Prices change: no currency or per-token number anywhere in a row.
      expect(JSON.stringify(r)).not.toMatch(/[$€¥]|\bper (1M|million)\b|\/M tokens/i);
    }
  });

  it("the new providers: OpenAI-compatible base URLs checked against their docs", () => {
    expect(presetOf("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(presetOf("deepinfra")?.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
    expect(presetOf("groq")?.baseUrl).toBe("https://api.groq.com/openai/v1");
    const w = presetOf("workers-ai")!;
    expect(w.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1");
    expect(w.protocol).toBe("openai");
    // api.cloudflare.com sends no CORS headers: a page cannot call it.
    expect(w.browser).toBe(false);
    expect(MODEL_RE.test("@cf/meta/llama-3.1-8b-instruct")).toBe(true);
  });
});

describe("relay allowlist stays in code", () => {
  it("is exactly the reviewed five", () => {
    expect(RELAY_PRESETS.map((p) => p.id)).toEqual(Object.keys(RELAY_ALLOW));
    expect(Object.keys(RELAY_ALLOW)).toEqual([
      "openai",
      "anthropic",
      "deepseek",
      "gemini",
      "openrouter",
    ]);
    expect(relayPresetOf("deepinfra")).toBeNull();
    expect(relayPresetOf(undefined)).toBeNull();
    expect(relayPresetOf("openai")?.relay?.host).toBe("api.openai.com");
  });

  it("a config row never brings its own relay, and a moved base URL loses it", () => {
    const sneaky = { ...row(), relay: { host: "evil.example", paths: ["/"] } } as ByokPresetRow;
    expect(presetsFrom([sneaky])[0].relay).toBeUndefined();
    expect(presetRowSchema.safeParse(sneaky).success).toBe(false);
    const moved = presetsFrom([row({ id: "openai", baseUrl: "https://evil.example/v1" })]);
    expect(moved[0].relay).toBeUndefined();
    const kept = presetsFrom([row({ id: "openai", baseUrl: "https://api.openai.com/v1" })]);
    expect(kept[0].relay).toBe(RELAY_ALLOW.openai);
    expect(presetsFrom([row({ id: "openai", baseUrl: "not a url" })])[0].relay).toBeUndefined();
  });

  it("the relay server ignores the live config", () => {
    setPublicConfig({ "byok.presets": [row()] });
    expect(presetOf("acme")).not.toBeNull();
    expect(checkBackend("acme", "https://api.acme.example/v1")).toEqual({
      ok: false,
      reason: "provider",
    });
  });
});

describe("the schema", () => {
  const bad: [string, unknown][] = [
    ["custom id", row({ id: "custom" })],
    ["uppercase id", row({ id: "Acme" })],
    ["http to the internet", row({ baseUrl: "http://api.acme.example/v1" })],
    ["query in base", row({ baseUrl: "https://api.acme.example/v1?x=1" })],
    ["credentials in base", row({ baseUrl: "https://u:p@api.acme.example/v1" })],
    ["bad model", row({ model: "has space" })],
    ["http pricing", row({ pricingUrl: "http://acme.example/pricing" })],
    ["bad tier", row({ models: [{ id: "m", tier: "free" as never }] })],
    ["bad note locale", row({ note: { English: "x" } })],
    ["empty note", row({ note: { en: " " } })],
    ["unknown field", { ...row(), price: 1 }],
  ];
  for (const [what, v] of bad)
    it(`refuses ${what}`, () => expect(presetRowSchema.safeParse(v).success).toBe(false));

  it("takes localhost over http, a full row, and refuses duplicate or empty lists", () => {
    expect(presetRowSchema.safeParse(row({ baseUrl: "http://localhost:1234/v1" })).success).toBe(
      true,
    );
    const full = row({
      keyless: false,
      opaqueAuthErrors: false,
      policyUrl: "https://acme.example/privacy",
      pricingUrl: "https://acme.example/pricing",
      keyUrl: "https://acme.example/keys",
      models: [
        { id: "acme-small", tier: "cheap" },
        { id: "acme-big", tier: "strong" },
      ],
      note: { en: "Acme's models.", "zh-Hant": "Acme 的模型。" },
    });
    expect(presetListSchema.safeParse([full]).success).toBe(true);
    expect(presetListSchema.safeParse([row(), row()]).success).toBe(false);
    expect(presetListSchema.safeParse([]).success).toBe(false);
  });
});

describe("live list", () => {
  it("is the default until the config arrives, then whatever the key holds, Custom last", () => {
    expect(livePresets().map((p) => p.id)).toEqual(BYOK_PRESETS.map((p) => p.id));
    const first = livePresets();
    expect(livePresets()).toBe(first);
    setPublicConfig({ "byok.presets": [row(), DEFAULT_PRESET_ROWS[0]] });
    expect(livePresets().map((p) => p.id)).toEqual(["acme", "openai", "custom"]);
    expect(presetOf("openai")?.relay).toBe(RELAY_ALLOW.openai);
    expect(presetOf("gemini")).toBeNull();
    expect(presetOf(null)).toBeNull();
  });

  it("an invalid config value falls back to the default", () => {
    setPublicConfig({ "byok.presets": [row({ id: "custom" })] });
    expect(livePresets().map((p) => p.id)).toEqual(BYOK_PRESETS.map((p) => p.id));
  });

  it("a row's note by locale, then its language, then English", () => {
    const r = row({ note: { en: "E", zh: "Z", "pt-BR": "P" } });
    expect(rowNote(r, "zh")).toBe("Z");
    expect(rowNote(r, "zh-Hant")).toBe("Z");
    expect(rowNote(r, "pt-BR")).toBe("P");
    expect(rowNote(r, "ja")).toBe("E");
    expect(rowNote(row({ note: { zh: "Z" } }), "ja")).toBeNull();
    expect(rowNote(row(), "en")).toBeNull();
  });
});
