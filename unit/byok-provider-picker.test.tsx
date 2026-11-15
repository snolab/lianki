// Settings → Your own AI: the provider picker as one segmented pill and the
// preset's info under it (app/components/ByokProviderPicker.tsx; owner rule
// 2026-11-15: many options = one segmented control, the chosen one filled
// seal red, all visible).
import { afterAll, describe, expect, it } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { stubGlobals } from "./support/globals";
import { mockIntlayer } from "./intlayer-mock";
import { BYOK_PRESETS, presetOf, type ByokPreset } from "@/lib/byok/presets";

mockIntlayer("en");

const win = new Window({ url: "https://lianki.com/my/preferences" });
const restore = stubGlobals({
  window: win,
  document: win.document,
  navigator: win.navigator,
  Event: win.Event,
  HTMLElement: win.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => restore());

const { createRoot } = await import("react-dom/client");
const { ByokProviderPicker, ByokPresetInfo, stepIndex } =
  await import("@/app/components/ByokProviderPicker");

const TEXT = {
  recommended: "Recommended models",
  tiers: { cheap: "cheapest", balanced: "balanced", strong: "strongest" },
  pricing: "{name} prices",
  getKey: "Get an API key",
  serverOnly: "{name} does not accept calls from a web page.",
};

async function mountPicker(value: string, dir?: "rtl") {
  const host = win.document.createElement("div");
  if (dir) host.setAttribute("dir", dir);
  win.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  const picks: string[] = [];
  let current = value;
  const render = () =>
    root.render(
      <ByokProviderPicker
        presets={BYOK_PRESETS}
        value={current}
        onPick={(id) => {
          picks.push(id);
          current = id;
          render();
        }}
        label="Provider"
        customLabel="Custom (OpenAI-compatible)"
      />,
    );
  await act(async () => render());
  const radios = () => [...host.querySelectorAll('[role="radio"]')] as unknown as HTMLElement[];
  const key = async (k: string) =>
    act(async () => {
      host
        .querySelector('[role="radiogroup"]')!
        .dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }) as never);
    });
  return {
    host,
    picks,
    radios,
    key,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("ByokProviderPicker", () => {
  it("shows every provider in one radiogroup, the chosen one filled seal red", async () => {
    const m = await mountPicker("deepinfra");
    const g = m.host.querySelector('[role="radiogroup"]')!;
    expect(g.getAttribute("aria-label")).toBe("Provider");
    expect(m.host.querySelector("select")).toBeNull();
    const r = m.radios();
    expect(r.map((b) => b.getAttribute("data-provider"))).toEqual(BYOK_PRESETS.map((p) => p.id));
    expect(r.at(-1)!.textContent).toBe("Custom (OpenAI-compatible)");
    const on = r.filter((b) => b.getAttribute("aria-checked") === "true");
    expect(on.map((b) => b.textContent)).toEqual(["DeepInfra"]);
    expect(on[0].className).toContain("bg-seal");
    expect(on[0].tabIndex).toBe(0);
    expect(r.filter((b) => b.tabIndex === -1).length).toBe(r.length - 1);
    await m.unmount();
  });

  it("a tap picks; tapping the chosen one does nothing", async () => {
    const m = await mountPicker("openai");
    await act(async () => m.radios()[0].click());
    expect(m.picks).toEqual([]);
    await act(async () => m.radios()[4].click());
    expect(m.picks).toEqual(["openrouter"]);
    await m.unmount();
  });

  it("arrows, Home and End move the choice (wrapping), other keys do nothing", async () => {
    const m = await mountPicker("openai");
    await m.key("ArrowRight");
    await m.key("ArrowDown");
    await m.key("ArrowUp");
    await m.key("ArrowLeft");
    await m.key("ArrowLeft");
    await m.key("End");
    await m.key("End");
    await m.key("Home");
    await m.key("a");
    expect(m.picks).toEqual(["anthropic", "deepseek", "anthropic", "openai", "custom", "openai"]);
    await m.unmount();
  });

  it("right-to-left flips the horizontal arrows; an unknown value marks the first", async () => {
    const m = await mountPicker("nope", "rtl");
    expect(m.radios()[0].getAttribute("aria-checked")).toBe("true");
    await m.key("ArrowRight");
    expect(m.picks).toEqual(["custom"]);
    await m.unmount();
  });

  it("stepIndex", () => {
    expect(stepIndex("ArrowRight", 0, 3, false)).toBe(1);
    expect(stepIndex("ArrowRight", 0, 3, true)).toBe(2);
    expect(stepIndex("ArrowLeft", 2, 3, true)).toBe(0);
    expect(stepIndex("Home", 2, 3, false)).toBe(0);
    expect(stepIndex("End", 0, 3, false)).toBe(2);
    expect(stepIndex("Enter", 0, 3, false)).toBeNull();
  });
});

describe("ByokPresetInfo", () => {
  const html = (preset: ByokPreset, note: string | null = null, model = "") =>
    renderToStaticMarkup(
      <ByokPresetInfo preset={preset} note={note} model={model} onModel={() => {}} text={TEXT} />,
    );

  it("note, pricing and key links, recommended models with tier words, the one in use red", () => {
    const p = presetOf("openrouter")!;
    const h = html(p, "One key for many models.", "openrouter/auto");
    expect(h).toContain("One key for many models.");
    expect(h).toContain(`href="${p.pricingUrl}"`);
    expect(h).toContain("OpenRouter prices");
    expect(h).toContain(`href="${p.keyUrl}"`);
    expect(h).toContain('rel="noopener noreferrer"');
    for (const m of p.models!) expect(h).toContain(`data-model="${m.id}"`);
    expect(h).toContain("cheapest");
    expect(h).toContain("strongest");
    expect(h.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(h).toMatch(/aria-pressed="true" data-model="openrouter\/auto" class="[^"]*bg-seal/);
    expect(h).not.toContain("byok-server-only");
    // No prices: only the provider's page.
    expect(h).not.toMatch(/\$\d/);
  });

  it("says when a browser cannot call the provider", () => {
    expect(html(presetOf("workers-ai")!)).toContain(
      "Workers AI does not accept calls from a web page.",
    );
  });

  it("no key link for a keyless provider; nothing at all for a bare one", () => {
    const o = html(presetOf("ollama")!, "Local.");
    expect(o).toContain("Local.");
    expect(o).not.toContain("byok-link-key");
    expect(html(presetOf("custom")!)).toBe("");
  });

  it("a tap on a model fills it in", async () => {
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    const got: string[] = [];
    await act(async () =>
      root.render(
        <ByokPresetInfo
          preset={presetOf("deepinfra")!}
          note={null}
          model=""
          onModel={(m) => got.push(m)}
          text={TEXT}
        />,
      ),
    );
    await act(async () => (host.querySelector("[data-model]") as unknown as HTMLElement).click());
    expect(got).toEqual(["meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"]);
    await act(async () => root.unmount());
    host.remove();
  });
});
