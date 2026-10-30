import { describe, expect, it } from "bun:test";
import {
  REACT_GLOBAL,
  WIDGET_API,
  eventsUrl,
  failNote,
  loadWidget,
  widgetSrc,
  widgetUrl,
} from "@lianki/debug-chat/debug-widget";
import {
  allowOrigin,
  devOrigins,
  buildHarness,
  buildWidget,
  candidates,
  harnessCss,
  hostModule,
  sse,
  themeBlock,
  topBlocks,
} from "@/scripts/dev/debug-widget-build";

describe("widgetSrc: which URLs the owner's page will import", () => {
  it("any https URL, or http on localhost only", () => {
    expect(widgetSrc("https://dev-mac.lianki.com/debug-chat.js")?.href).toBe(
      "https://dev-mac.lianki.com/debug-chat.js",
    );
    expect(widgetSrc(" http://localhost:5180/debug-chat.js ")?.host).toBe("localhost:5180");
    expect(widgetSrc("http://127.0.0.1:5180/x.js")).not.toBeNull();
    expect(widgetSrc("http://[::1]:5180/x.js")).not.toBeNull();
    for (const bad of [
      "http://evil.example/x.js",
      "javascript:alert(1)",
      "data:text/javascript,1",
      "not a url",
      "",
      null,
      undefined,
    ])
      expect(widgetSrc(bad)).toBeNull();
  });

  it("cache-busts per rev and finds /events next to the module", () => {
    const src = new URL("https://my-mac.example-tailnet.ts.net/lianki-widget/debug-chat.js");
    expect(widgetUrl(src)).toBe(src.href);
    expect(widgetUrl(src, "ab12")).toBe(`${src.href}?v=ab12`);
    expect(eventsUrl(src)).toBe("https://my-mac.example-tailnet.ts.net/lianki-widget/events");
  });
});

describe("loadWidget", () => {
  const Chat = () => null;
  it("returns the component, its CSS and rev", async () => {
    const m = await loadWidget("u", async () => ({
      DebugChat: Chat,
      WIDGET_API,
      css: "a{}",
      rev: "r1",
    }));
    expect(m).toEqual({ Chat, css: "a{}", rev: "r1" });
    const bare = await loadWidget("u", async () => ({ DebugChat: Chat, WIDGET_API }));
    expect(bare).toEqual({ Chat, css: "", rev: "" });
  });
  it("refuses a module that is not a widget for this page", async () => {
    await expect(loadWidget("u", async () => ({ WIDGET_API }))).rejects.toThrow("no DebugChat");
    await expect(
      loadWidget("u", async () => ({ DebugChat: Chat, WIDGET_API: 99 })),
    ).rejects.toThrow(`widget API 99, this page wants ${WIDGET_API}`);
    await expect(loadWidget("u", () => Promise.reject(new Error("404")))).rejects.toThrow("404");
  });
  it("failNote is one bounded line", () => {
    expect(failNote(new Error("boom"))).toBe("dev widget failed (boom); using the built-in chat");
    expect(failNote("x".repeat(500)).length).toBeLessThan(200);
  });
});

describe("the widget build", () => {
  it("hostModule reads React from the page", () => {
    const react = hostModule("react", ["default", "useState", "useRef", "not-an-ident"]);
    expect(react).toContain(`globalThis["${REACT_GLOBAL}"].React`);
    expect(react).toContain("export const { useState, useRef } = R;");
    expect(react).not.toContain("not-an-ident");
    expect(hostModule("react-dom", [])).toContain(".ReactDOM;");
    expect(hostModule("react-dom", [])).not.toContain("export const {");
    for (const rt of ["react/jsx-runtime", "react/jsx-dev-runtime"])
      expect(hostModule(rt, [])).toContain("export const jsxDEV");
  });

  it("candidates, themeBlock, allowOrigin, sse", () => {
    expect(candidates('className="a b-[1px]" x={`c ${d}`}')).toEqual(
      expect.arrayContaining(["a", "b-[1px]", "c"]),
    );
    expect(candidates('className="w-[min(20rem,calc(100vw-1rem))]"')).toContain(
      "w-[min(20rem,calc(100vw-1rem))]",
    );
    expect(themeBlock("x{} @theme { --a: 1; .b { c: d } } y{}")).toBe(
      "@theme { --a: 1; .b { c: d } }",
    );
    expect(themeBlock("a{}")).toBe("");
    expect(themeBlock("@theme { open")).toBe("");
    expect(allowOrigin("https://lianki.com")).toBe("https://lianki.com");
    expect(allowOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(allowOrigin("https://evil.example")).toBe("https://lianki.com");
    expect(allowOrigin("garbage")).toBe("https://lianki.com");
    expect(allowOrigin(null)).toBe("https://lianki.com");
    // LIANKI_DEV_ORIGINS: exact https origins only.
    const dev = devOrigins(
      " https://dev.example.ts.net:8443 , http://plain.example, junk,https://b.example/x",
    );
    expect(dev).toEqual(["https://dev.example.ts.net:8443", "https://b.example"]);
    expect(allowOrigin("https://dev.example.ts.net:8443", dev)).toBe(
      "https://dev.example.ts.net:8443",
    );
    expect(allowOrigin("https://dev.example.ts.net:9443", dev)).toBe("https://lianki.com");
    expect(allowOrigin("https://evil.example", dev)).toBe("https://lianki.com");
    expect(devOrigins(undefined)).toEqual([]);
    expect(sse("reload", "r1")).toBe("event: reload\ndata: r1\n\n");
  });

  it("bundles DebugChat as ESM with no React of its own, plus its CSS and rev", async () => {
    const b = await buildWidget();
    expect(b.code).not.toMatch(/from\s*["']react/);
    expect(b.code).not.toContain("react.production");
    expect(b.code).toContain(`globalThis["${REACT_GLOBAL}"]`);
    expect(b.code).toMatch(/export\s*{[^}]*DebugChat/);
    expect(b.code).toContain(`export const rev = "${b.rev}"`);
    expect(b.css).toContain(".animate-spin");
    expect(b.inputs.some((p) => p.endsWith("packages/debug-chat/src/DebugChat.tsx"))).toBe(true);
    expect((await buildWidget()).rev).toBe(b.rev);
  }, 30_000);

  it("splits a stylesheet into its top-level blocks", () => {
    const css = "@import 'x';\n/* note */ .a { b: c }\n@media (x) { .d { e: f } }";
    expect(topBlocks(css)).toEqual([
      [".a", ".a { b: c }"],
      ["@media (x)", "@media (x) { .d { e: f } }"],
    ]);
  });

  it("gives /harness the app's colours, halo, tap area and send bar", () => {
    const css = harnessCss();
    expect(css).toContain("@layer base");
    expect(css).toContain("--background:");
    expect(css).toContain("prefers-color-scheme: dark");
    for (const sel of [".lk-halo", ".tap-40::before", ".lk-drain", "@keyframes lk-drain"])
      expect(css).toContain(sel);
    expect(css).not.toContain("--glass");
  });

  it("bundles the local harness page", async () => {
    expect(await buildHarness()).toContain("createRoot");
  }, 30_000);
});
