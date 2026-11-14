import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { FLAG_KEYS, FLAG_OLD_KEYS, FLAGS, type FlagDef, type FlagKey } from "@/lib/flags";
import type { FlagRow } from "@/lib/flags-store";
import { FlagCard, MONEY_NOTE } from "@/app/(app)/dev/flags/FlagCard";
import {
  assignGroups,
  buildFlagView,
  filtersActive,
  groupDomId,
  groupOfRow,
  isGroupOpen,
  isRecent,
  isShipped,
  matchesSearch,
  NO_FILTERS,
  OTHER_GROUP,
  rawFlagGroup,
  RECENT_DAYS,
  resolveFlagAnchor,
  SHIPPED_GROUP,
  type FlagViewInput,
} from "@/app/(app)/dev/flags/flag-view";
import { cleanFlagViewPrefs } from "@/app/(app)/dev/flags/flag-view-store";
import { mockIntlayer } from "./intlayer-mock";

mockIntlayer();

const NOW = Date.parse("2026-11-06T09:00:00Z");
const FAILED = [{ check: "stripe.live-key", reason: "stripe.no-live-key", text: "x" }] as never[];

const row = (key: FlagKey, over: Partial<FlagRow> = {}): FlagRow => ({
  key,
  description: FLAGS[key].description,
  enabled: false,
  updatedAt: null,
  updatedBy: null,
  ...over,
});
const all = (over: Partial<Record<FlagKey, Partial<FlagRow>>> = {}) =>
  FLAG_KEYS.map((k) => row(k, over[k]));
const input = (over: Partial<FlagViewInput> = {}): FlagViewInput => ({
  ...NO_FILTERS,
  now: NOW,
  ...over,
});
const keysIn = (rows: FlagRow[], over: Partial<FlagViewInput> = {}) =>
  buildFlagView(rows, input(over)).flatMap((g) => g.rows.map((r) => r.key));

describe("grouping", () => {
  test("the prefix, unless the flag names a group", () => {
    expect(rawFlagGroup("read.vibe")).toBe("read");
    expect(rawFlagGroup("payments.stripe.live")).toBe("payments");
    expect(rawFlagGroup("levels")).toBe("levels");
    expect(rawFlagGroup("my-box", { group: "box" })).toBe("box");
  });

  test("a group of one goes to 其他: a new prefix adds no heading by itself", () => {
    const groups = assignGroups(["a.one", "a.two", "lonely.one", "single"], () => undefined);
    expect(groups.get("a.one")).toBe("a");
    expect(groups.get("a.two")).toBe("a");
    expect(groups.get("lonely.one")).toBe(OTHER_GROUP);
    expect(groups.get("single")).toBe(OTHER_GROUP);
  });

  test("every flag is in exactly one section; no section is a lone flag but 其他", () => {
    const view = buildFlagView(all(), input());
    expect(view.flatMap((g) => g.rows.map((r) => r.key)).sort()).toEqual([...FLAG_KEYS].sort());
    for (const g of view) if (g.id !== OTHER_GROUP) expect(g.rows.length).toBeGreaterThan(1);
  });

  test("my-box sits with box.oauth, and groups stay few", () => {
    const g = assignGroups();
    expect(g.get("my-box")).toBe(g.get("box.oauth")!);
    // 8 since 2026-11-15: the login-streak and sign-up bonus share a 积分 section.
    expect(new Set(g.values()).size).toBeLessThan(9);
  });

  test("其他, then shipped, come last", () => {
    const view = buildFlagView(
      all({ levels: {}, "read.youtube-songs": { enabled: true } }),
      input(),
    );
    const ids = view.map((g) => g.id);
    expect(ids.at(-1)).toBe(SHIPPED_GROUP);
    expect(ids.at(-2)).toBe(OTHER_GROUP);
  });

  test("a group's DOM id can't collide with a flag's", () => {
    for (const id of new Set(assignGroups().values()))
      expect(FLAG_KEYS as string[]).not.toContain(groupDomId(id));
  });

  test("the section's count is the whole section, whatever is shown", () => {
    const rows = all({ "read.vibe": { enabled: true } });
    const read = buildFlagView(rows, input({ q: "read.vibe" })).find((g) => g.id === "read")!;
    expect(read.rows.map((r) => r.key)).toEqual(["read.vibe"]);
    expect(read.total).toBeGreaterThan(1);
    expect(read.on).toBe(1);
  });
});

describe("the shipped view", () => {
  test("on for everyone: on, every user, nothing missing", () => {
    expect(isShipped(row("read.youtube-songs", { enabled: true }))).toBe(true);
    expect(isShipped(row("read.youtube-songs"))).toBe(false);
  });
  test("never a flag that reaches only the owner: read.vibe on is not shipped", () => {
    expect(isShipped(row("read.vibe", { enabled: true }))).toBe(false);
    expect(isShipped(row("stt.merge", { enabled: true }))).toBe(false);
    expect(isShipped(row("my-box", { enabled: true }))).toBe(false);
  });
  test("never a payment flag: a standing kill switch, not a rollout", () => {
    for (const k of FLAG_KEYS)
      if ((FLAGS[k] as FlagDef).money) expect(isShipped(row(k, { enabled: true }))).toBe(false);
  });
  test("never a flag on while a prerequisite fails", () => {
    expect(isShipped(row("partner.ai-reply", { enabled: true }), FAILED)).toBe(false);
    expect(isShipped(row("partner.ai-reply", { enabled: true }))).toBe(true);
  });
  test("starts folded; every other section starts open; the device's choice wins", () => {
    expect(isGroupOpen({}, SHIPPED_GROUP)).toBe(false);
    expect(isGroupOpen({}, "read")).toBe(true);
    expect(isGroupOpen({ [SHIPPED_GROUP]: true, read: false }, SHIPPED_GROUP)).toBe(true);
    expect(isGroupOpen({ [SHIPPED_GROUP]: true, read: false }, "read")).toBe(false);
  });
  test("a flag toggled just now stays where it was until the view is asked again", () => {
    const on = row("read.youtube-songs", { enabled: true });
    expect(groupOfRow(on, {})).toBe(SHIPPED_GROUP);
    expect(groupOfRow(on, { held: new Map([[on.key, false]]) })).toBe("read");
    const off = row("read.youtube-songs");
    expect(groupOfRow(off, { held: new Map([[off.key, true]]) })).toBe(SHIPPED_GROUP);
  });
});

describe("search", () => {
  test("by key and by description, ignoring case", () => {
    expect(matchesSearch(row("read.vibe"), "VIBE")).toBe(true);
    expect(matchesSearch(row("read.vibe"), "对话日记")).toBe(true);
    expect(matchesSearch(row("read.vibe"), "stripe")).toBe(false);
  });
  test("every term must match, in any order; blank matches all", () => {
    expect(matchesSearch(row("read.vibe"), "  对话日记   vibe ")).toBe(true);
    expect(matchesSearch(row("read.vibe"), "vibe stripe")).toBe(false);
    expect(matchesSearch(row("read.vibe"), "   ")).toBe(true);
  });
  test("full-width input matches", () => {
    expect(matchesSearch(row("read.vibe"), "ｖｉｂｅ")).toBe(true);
  });
  test("a renamed flag is found by its old key", () => {
    expect(matchesSearch({ key: "my-box", description: "d" }, "custom-frontend")).toBe(true);
  });
  test("drops sections with nothing to show", () => {
    const view = buildFlagView(all(), input({ q: "stripe" }));
    expect(view.map((g) => g.id)).toEqual(["payments"]);
  });
});

describe("filters", () => {
  const rows = all({
    "read.vibe": { enabled: true, updatedAt: new Date(NOW - 3_600_000).toISOString() },
    "stt.merge": { updatedAt: new Date(NOW - (RECENT_DAYS + 1) * 86_400_000).toISOString() },
  });

  test("on and off", () => {
    expect(keysIn(rows, { state: "on" })).toEqual(["read.vibe"]);
    const off = keysIn(rows, { state: "off" });
    expect(off).not.toContain("read.vibe");
    expect(off.length).toBe(FLAG_KEYS.length - 1);
  });
  test("recently changed uses the stored time", () => {
    expect(isRecent({ updatedAt: null }, NOW)).toBe(false);
    expect(keysIn(rows, { recent: true })).toEqual(["read.vibe"]);
  });
  test("filters and search combine", () => {
    expect(keysIn(rows, { state: "off", q: "vibe" })).toEqual([]);
    expect(keysIn(rows, { state: "on", q: "vibe" })).toEqual(["read.vibe"]);
  });
  test("what counts as active", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, q: "  " })).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, q: "x" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, state: "off" })).toBe(true);
    expect(filtersActive({ ...NO_FILTERS, recent: true })).toBe(true);
  });
  test("stored view state is cleaned", () => {
    expect(cleanFlagViewPrefs(null)).toEqual({});
    expect(
      cleanFlagViewPrefs({ state: "bogus", recent: "yes", open: { read: false, stt: 1 }, x: 1 }),
    ).toEqual({ open: { read: false } });
    expect(cleanFlagViewPrefs({ state: "off", recent: true, open: [] })).toEqual({
      state: "off",
      recent: true,
    });
  });
});

describe("a link's target", () => {
  test("the key itself, dots kept, encoded or not", () => {
    expect(resolveFlagAnchor("#read.youtube-songs")).toBe("read.youtube-songs");
    expect(resolveFlagAnchor("#read%2Eyoutube-songs")).toBe("read.youtube-songs");
    expect(resolveFlagAnchor("#levels")).toBe("levels");
  });
  test("an old key lands on the new one", () => {
    expect(resolveFlagAnchor("#live.custom-frontend")).toBe("my-box");
    for (const [key, old] of Object.entries(FLAG_OLD_KEYS))
      expect(resolveFlagAnchor(`#${old}`)).toBe(key as FlagKey);
  });
  test("anything else names no flag", () => {
    expect(resolveFlagAnchor("")).toBeNull();
    expect(resolveFlagAnchor("#")).toBeNull();
    expect(resolveFlagAnchor("#no.such.flag")).toBeNull();
    expect(resolveFlagAnchor("#constructor")).toBeNull();
    expect(resolveFlagAnchor("#flag-group-read")).toBeNull();
  });
  test("no search or filter hides it", () => {
    const rows = all();
    const pinned = "my-box";
    expect(keysIn(rows, { q: "stripe", pinned })).toContain(pinned);
    expect(keysIn(rows, { q: "stripe", pinned })).toContain("payments.stripe.live");
    expect(keysIn(rows, { state: "on", pinned })).toEqual([pinned]);
    expect(keysIn(rows, { recent: true, pinned })).toEqual([pinned]);
  });
  test("it stays in its own section, the shipped one too", () => {
    const rows = all({ "read.youtube-songs": { enabled: true } });
    const view = buildFlagView(rows, input({ state: "off", pinned: "read.youtube-songs" }));
    expect(view.find((g) => g.id === SHIPPED_GROUP)?.rows.map((r) => r.key)).toEqual([
      "read.youtube-songs",
    ]);
  });
  test("a flag just toggled is not filtered away from under the finger", () => {
    const rows = all();
    const held = new Map<FlagKey, boolean>([["levels", false]]);
    expect(keysIn(rows, { state: "on", held })).toEqual(["levels"]);
  });
});

describe("the row", () => {
  const html = (over: Partial<Parameters<typeof FlagCard>[0]> = {}) =>
    renderToString(
      createElement(FlagCard, { flag: row("levels"), busy: false, onToggle() {}, ...over }),
    );

  test("folded: name, state and switch; no description", () => {
    const out = html({ flag: row("levels", { description: "THE-DESCRIPTION" }) });
    expect(out).toContain("levels");
    expect(out).toContain("关");
    expect(out).toContain('role="switch"');
    expect(out).not.toContain("THE-DESCRIPTION");
    expect(out).toContain('aria-expanded="false"');
  });
  test("unfolded: the description and the last change", () => {
    const out = html({
      expanded: true,
      flag: row("levels", { description: "THE-DESCRIPTION" }),
    });
    expect(out).toContain("THE-DESCRIPTION");
    expect(out).toContain("从未改过");
    expect(out).toContain('aria-expanded="true"');
  });
  test("what stops a switch is there folded too: the reasons, the money note", () => {
    const out = html({ flag: row("payments.stripe.live"), failed: FAILED });
    expect(out).toContain("不能打开");
    expect(out).toContain(MONEY_NOTE);
  });
  test("the switch is not inside the unfolding button", () => {
    const out = html();
    expect(out.indexOf('role="switch"')).toBeGreaterThan(out.indexOf("</button>"));
  });
  test("colours are oklch only", () => {
    for (const f of ["FlagCard.tsx", "FlagsAdmin.tsx"]) {
      const src = readFileSync(`app/(app)/dev/flags/${f}`, "utf8");
      expect(src).not.toMatch(/#[0-9a-f]{6}\b|rgba?\(|hsla?\(/i);
    }
  });
  test("the payment confirmation is still there, on the toggle", () => {
    const src = readFileSync("app/(app)/dev/flags/FlagsAdmin.tsx", "utf8");
    expect(src).toContain('f.key.startsWith("payments.") && !window.confirm(');
  });
});
