import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";

/**
 * The review dialog's store indicator and due count.
 *
 * The panel looked identical whether you were signed in or not, so "did that
 * review reach my account?" had no answer short of opening /data — and the only
 * way to see how many cards were waiting was to finish them.
 *
 * Runs against the BUILT public/lianki.user.js, since that is what users
 * install, lifting the real functions rather than restating them.
 */
const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

function bodyEnd(start: number) {
  const open = BUILT.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < BUILT.length; i++) {
    if (BUILT[i] === "{") depth++;
    else if (BUILT[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("unterminated block in the built userscript");
}

function lift<T>(decl: string, name: string): T {
  const start = BUILT.indexOf(decl);
  if (start === -1) throw new Error(`${decl} not found in the built userscript`);
  return new Function(`${BUILT.slice(start, bodyEnd(start))}; return ${name};`)() as T;
}

type Badge = { icon: string; title: string };
const storeBadge = lift<(s: string) => Badge>("function storeBadge(", "storeBadge");
const dueCountFromIndex = lift<(i: unknown, n?: Date) => number>(
  "function dueCountFromIndex(",
  "dueCountFromIndex",
);

describe("where the cards live", () => {
  it("distinguishes all three states with different icons", () => {
    const cloud = storeBadge("cloud");
    const local = storeBadge("local");
    const offline = storeBadge("offline");
    expect(new Set([cloud.icon, local.icon, offline.icon]).size).toBe(3);
  });

  it("says 'account' for cloud and 'this browser' for local", () => {
    expect(storeBadge("cloud").title).toMatch(/account/i);
    expect(storeBadge("local").title).toMatch(/this browser/i);
  });

  it("tells a signed-out visitor that syncing is free", () => {
    // The whole point of surfacing the store: "sign in" reads as a paywall
    // unless you say otherwise.
    expect(storeBadge("local").title).toMatch(/free/i);
  });

  it("marks offline as will-sync-later, not as a failure", () => {
    expect(storeBadge("offline").title).toMatch(/offline/i);
    expect(storeBadge("offline").title).toMatch(/sync/i);
  });

  it("treats an unknown state as local, never as synced", () => {
    // Claiming "synced" when we do not know would be the one actively
    // misleading answer.
    expect(storeBadge("").icon).toBe(storeBadge("local").icon);
    expect(storeBadge("wat").icon).toBe(storeBadge("local").icon);
  });
});

describe("the due count", () => {
  const at = (iso: string) => new Date(iso);
  const idx = [
    { url: "a", due: "2026-01-01T00:00:00Z" },
    { url: "b", due: "2026-01-02T00:00:00Z" },
    { url: "c", due: "2030-01-01T00:00:00Z" },
  ];

  it("counts cards at or past their due date", () => {
    expect(dueCountFromIndex(idx, at("2026-01-02T00:00:00Z"))).toBe(2);
    expect(dueCountFromIndex(idx, at("2025-12-31T00:00:00Z"))).toBe(0);
  });

  it("excludes tombstones — a deleted card is not waiting for you", () => {
    const withDeleted = [...idx, { url: "d", due: "2026-01-01T00:00:00Z", del: 1 }];
    expect(dueCountFromIndex(withDeleted, at("2026-01-02T00:00:00Z"))).toBe(2);
  });

  it("survives a malformed index instead of breaking the dialog", () => {
    // GM storage is user-editable and has held junk before; a header that
    // throws takes the whole review panel with it.
    expect(dueCountFromIndex(null)).toBe(0);
    expect(dueCountFromIndex(undefined)).toBe(0);
    expect(dueCountFromIndex("nope" as unknown)).toBe(0);
    expect(dueCountFromIndex([null, undefined] as unknown)).toBe(0);
  });

  it("ignores an unparseable due date rather than counting it as due", () => {
    expect(dueCountFromIndex([{ url: "x", due: "not-a-date" }], at("2030-01-01T00:00:00Z"))).toBe(
      0,
    );
  });
});

describe("the header actually uses them", () => {
  it("renders the icon and the count together", () => {
    expect(BUILT).toMatch(/storeBadge\(cardStore\)/);
    expect(BUILT).toMatch(/dueCountFromIndex\(/);
    expect(BUILT).toMatch(/due\} due/);
  });

  it("omits the count rather than guessing when the local store is unavailable", () => {
    // offlineReady false means there is no index to count; showing "0 due"
    // would be a lie.
    expect(BUILT).toMatch(/offlineReady \? dueCountFromIndex/);
  });

  it("derives the store from api() outcomes, treating 401/403 as local", () => {
    expect(BUILT).toMatch(
      /cardStore = r\.status === 401 \|\| r\.status === 403 \? "local" : "cloud"/,
    );
  });
});
