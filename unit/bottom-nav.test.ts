import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import config from "@/intlayer.config";
import bottomNav from "@/app/components/bottom-nav.content";
import { BottomNav } from "@/app/components/nav/BottomNav";
import { NavDrawerExtra } from "@/app/components/nav/NavDrawerExtra";
import { ACTIONS, ISLAND_VERSIONS } from "@/lib/islands/contract";
import {
  MAX_PINS,
  MAX_RECENT,
  cleanNavPins,
  cleanNavUi,
  isAppPath,
  navPins,
  navUi,
  noteVisit,
  setDrawerOpen,
  togglePin,
  withRecent,
} from "@/lib/nav/ui-store";

// The bottom island navigation (docs/bottom-nav.md). This first step only
// mounts its slots: production renders nothing new until the island is
// approved and becomes the built-in.

describe("the nav slots", () => {
  it("are in the islands contract and the dev server's entry", () => {
    expect(ISLAND_VERSIONS["nav.bottom"]).toBe(1);
    expect(ISLAND_VERSIONS["nav.drawer"]).toBe(1);
    const entry = readFileSync(new URL("../lib/islands/entry.ts", import.meta.url), "utf8");
    expect(entry).toContain('"nav.bottom": BottomNav');
    expect(entry).toContain('"nav.drawer": NavDrawerExtra');
  });

  it("render nothing built in, so production is unchanged", () => {
    expect(renderToString(createElement(BottomNav, { signedIn: true }))).toBe("");
    expect(
      renderToString(createElement(NavDrawerExtra, { place: "drawer", collapsed: false })),
    ).toBe("");
  });

  it("are mounted by the app shell, the drawer slot in both the drawer and the sidebar", () => {
    const shell = readFileSync(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
    expect(shell).toContain('island("nav.bottom", BottomNav)');
    expect(shell).toContain('island("nav.drawer", NavDrawerExtra)');
    expect(shell).toContain('sidebar("drawer")');
    expect(shell).toContain('sidebar("sidebar")');
  });

  it("chat.open takes an optional state-tree node", () => {
    expect(ACTIONS["chat.open"].safeParse({}).success).toBe(true);
    expect(ACTIONS["chat.open"].safeParse({ node: "/words/swipe" }).success).toBe(true);
    expect(ACTIONS["chat.open"].safeParse({ node: 3 }).success).toBe(false);
  });
});

describe("the nav stores", () => {
  it("app paths only", () => {
    expect(isAppPath("/words?list=a")).toBe(true);
    expect(isAppPath("//evil.example")).toBe(false);
    expect(isAppPath("https://x")).toBe(false);
    expect(isAppPath(3)).toBe(false);
    expect(isAppPath(`/${"a".repeat(400)}`)).toBe(false);
  });

  it("clean keeps valid, unique, capped paths and drops the rest", () => {
    expect(cleanNavUi(null)).toEqual({});
    expect(cleanNavUi({ recent: "x" })).toEqual({});
    expect(cleanNavUi({ recent: ["/a", "/a", "x", "/b"], drawerOpen: true })).toEqual({
      recent: ["/a", "/b"],
    });
    const many = Array.from({ length: 30 }, (_, i) => `/p${i}`);
    expect(cleanNavUi({ recent: many }).recent).toHaveLength(MAX_RECENT);
    expect(cleanNavPins(7)).toEqual({});
    expect(cleanNavPins({})).toEqual({});
    expect(cleanNavPins({ pinned: many }).pinned).toHaveLength(MAX_PINS);
  });

  it("withRecent moves a visit to the front, once", () => {
    expect(withRecent(["/a", "/b"], "/b")).toEqual(["/b", "/a"]);
    expect(withRecent(["/a"], "nope")).toEqual(["/a"]);
    expect(withRecent(["/a", "/b", "/c"], "/d", 3)).toEqual(["/d", "/a", "/b"]);
  });

  it("drawer, visits and pins", () => {
    setDrawerOpen(true);
    expect(navUi.getState().drawerOpen).toBe(true);
    setDrawerOpen(true);
    setDrawerOpen(false);
    expect(navUi.getState().drawerOpen).toBe(false);

    noteVisit("/words");
    noteVisit("/home");
    noteVisit("/home");
    expect(navUi.getState().recent.slice(0, 2)).toEqual(["/home", "/words"]);

    togglePin("/words");
    togglePin("bad");
    expect(navPins.getState().pinned).toEqual(["/words"]);
    togglePin("/words");
    expect(navPins.getState().pinned).toEqual([]);
  });
});

describe("bottom-nav strings", () => {
  const locales = config.internationalization!.locales! as string[];
  type Node = { nodeType?: string; translation?: Record<string, string> };
  const entries = Object.entries(bottomNav.content as Record<string, Node>);

  it("are all translations, with every key in every locale", () => {
    expect(entries.every(([, v]) => v.nodeType === "translation")).toBe(true);
    const missing = entries.flatMap(([k, v]) =>
      locales.filter((l) => !v.translation?.[l]?.trim()).map((l) => `${k}:${l}`),
    );
    expect(missing).toEqual([]);
  });

  it("keep each key's {placeholders} in every locale", () => {
    const ph = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join();
    const off = entries.flatMap(([k, v]) =>
      locales
        .filter((l) => ph(v.translation![l]) !== ph(v.translation!.en))
        .map((l) => `${k}:${l}`),
    );
    expect(off).toEqual([]);
  });

  it("translate French and Chinese rather than repeating the English", () => {
    const same = entries.flatMap(([k, v]) =>
      ["fr", "zh"].filter((l) => v.translation![l] === v.translation!.en).map((l) => `${k}:${l}`),
    );
    expect(same).toEqual([]);
  });
});
