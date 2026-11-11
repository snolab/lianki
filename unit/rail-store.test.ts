import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import shell from "@/app/components/app-shell.content";
import {
  LEGACY_SIDEBAR_KEY,
  adoptLegacyCollapsed,
  railUi,
  setRailCollapsed,
  takeLegacyCollapsed,
  toggleRail,
} from "@/lib/nav/rail-store";

// The left rail's fold (lib/nav/rail-store.ts; owner, 2026-11-11: he found no
// way to fold it on his tablet, and the folded rail still took width).

/** A Storage stand-in: a plain map, or one that throws like a blocked one. */
function mapStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => void m.delete(k),
  };
}
const blocked = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

beforeEach(() => railUi.setState({ collapsed: false }));

describe("railUi", () => {
  it("is a device preference, lk:pref:sidebar, open by default", () => {
    expect(railUi.key).toBe("lk:pref:sidebar");
    expect(railUi.storage).toBe("local");
    expect(railUi.initial).toEqual({ collapsed: false });
  });

  it("toggles and sets the fold", () => {
    toggleRail();
    expect(railUi.getState().collapsed).toBe(true);
    toggleRail();
    expect(railUi.getState().collapsed).toBe(false);
    setRailCollapsed(true);
    expect(railUi.getState().collapsed).toBe(true);
  });

  it("writes nothing when the fold does not change", () => {
    let writes = 0;
    const off = railUi.subscribe(() => writes++);
    setRailCollapsed(false);
    expect(writes).toBe(0);
    setRailCollapsed(true);
    setRailCollapsed(true);
    expect(writes).toBe(1);
    off();
  });
});

describe("the legacy lk:sidebar key", () => {
  it("is read once and removed", () => {
    const s = mapStore({ [LEGACY_SIDEBAR_KEY]: "1" });
    expect(takeLegacyCollapsed(s)).toBe(true);
    expect(s.m.has(LEGACY_SIDEBAR_KEY)).toBe(false);
    expect(takeLegacyCollapsed(s)).toBeNull();
    expect(takeLegacyCollapsed(mapStore({ [LEGACY_SIDEBAR_KEY]: "0" }))).toBe(false);
  });

  it("ignores junk, a missing store and a blocked one", () => {
    const junk = mapStore({ [LEGACY_SIDEBAR_KEY]: "yes" });
    expect(takeLegacyCollapsed(junk)).toBeNull();
    expect(junk.m.has(LEGACY_SIDEBAR_KEY)).toBe(true);
    expect(takeLegacyCollapsed(null)).toBeNull();
    expect(takeLegacyCollapsed(undefined)).toBeNull();
    expect(takeLegacyCollapsed(blocked)).toBeNull();
  });

  it("is carried into the store, and only when present", () => {
    adoptLegacyCollapsed(mapStore({ [LEGACY_SIDEBAR_KEY]: "1" }));
    expect(railUi.getState().collapsed).toBe(true);
    adoptLegacyCollapsed(mapStore());
    expect(railUi.getState().collapsed).toBe(true);
    adoptLegacyCollapsed(mapStore({ [LEGACY_SIDEBAR_KEY]: "0" }));
    expect(railUi.getState().collapsed).toBe(false);
  });
});

describe("the shell", () => {
  const app = src("app/components/AppShell.tsx");

  it("reserves no width for a folded rail", () => {
    // --nav-w is 14rem only while open; folded, the aside is not drawn.
    expect(app).toContain('collapsed ? "" : "md:[--nav-w:14rem]"');
    expect(app).not.toContain("md:[--nav-w:4rem]");
    expect(app).toMatch(/collapsed \? "" : "md:block"/);
  });

  it("has a fold switch that says its state", () => {
    expect(app).toContain("aria-expanded={!collapsed}");
    expect(app).toContain('aria-controls="lk-rail"');
    expect(app).toContain('id="lk-rail"');
    expect(app).toContain("data-rail-collapse");
    expect(app).toContain('data-rail-expand="header"');
    expect(app).toContain('data-rail-expand="float"');
  });

  it("labels the switch in every locale", () => {
    const ui = (shell.content as unknown as { ui: Record<string, { translation: object }> }).ui;
    for (const k of ["collapse", "expand", "closeMenu"]) {
      const t = ui[k].translation as Record<string, string>;
      expect(Object.keys(t).length).toBeGreaterThanOrEqual(16);
      for (const v of Object.values(t)) expect(v.trim().length).toBeGreaterThan(0);
    }
  });
});
