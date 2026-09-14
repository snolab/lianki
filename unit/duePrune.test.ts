import { describe, expect, test } from "bun:test";
import { dueWindow, isProvablyDeleted } from "@lianki/core/duePrune";

/**
 * The regression this exists for: with the default review order ("newest") the
 * server returns the LEAST overdue page, and the old prune treated everything
 * older than that page as deleted — tombstoning the entire backlog, permanently,
 * because deleting writes a fresh HLC the resurrect guard then honours.
 */
const LIMIT = 20;
const ago = (days: number) => Date.now() - days * 864e5;

/** A full page of the 20 least-overdue cards, as "newest" order returns. */
const newestPage = Array.from({ length: LIMIT }, (_, i) => ago(1 + i * 0.1));
/** A full page of the 20 most-overdue cards, as "oldest" order returns. */
const oldestPage = Array.from({ length: LIMIT }, (_, i) => ago(100 - i * 0.1));

describe("due-card prune window", () => {
  test("a backlog card beyond a FULL newest-first page is never pruned", () => {
    const w = dueWindow(newestPage, newestPage.length, LIMIT);
    // 90 days overdue: far older than anything the page covers.
    expect(isProvablyDeleted(ago(90), w)).toBe(false);
  });

  test("a fresher card beyond a FULL oldest-first page is never pruned", () => {
    const w = dueWindow(oldestPage, oldestPage.length, LIMIT);
    // Due an hour ago: newer than anything that page covers.
    expect(isProvablyDeleted(ago(1 / 24), w)).toBe(false);
  });

  test("a card INSIDE the covered span but absent from the page is deleted", () => {
    const w = dueWindow(newestPage, newestPage.length, LIMIT);
    const inside = (Math.min(...newestPage) + Math.max(...newestPage)) / 2;
    expect(isProvablyDeleted(inside, w)).toBe(true);
  });

  test("a SHORT page is authoritative for everything — the server ran out", () => {
    const w = dueWindow(newestPage.slice(0, 3), 3, LIMIT);
    expect(isProvablyDeleted(ago(90), w)).toBe(true);
    expect(isProvablyDeleted(ago(0.5), w)).toBe(true);
  });

  test("an EMPTY page means nothing is due, so every local due card is stale", () => {
    const w = dueWindow([], 0, LIMIT);
    expect(isProvablyDeleted(ago(7), w)).toBe(true);
  });

  test("an unreadable due date is kept, never dropped", () => {
    for (const page of [newestPage, []]) {
      const w = dueWindow(page, page.length, LIMIT);
      expect(isProvablyDeleted(NaN, w)).toBe(false);
    }
  });

  test("cards exactly at either edge are kept — a tie could have cut them", () => {
    const w = dueWindow(newestPage, newestPage.length, LIMIT);
    expect(isProvablyDeleted(w.lo, w)).toBe(false);
    expect(isProvablyDeleted(w.hi, w)).toBe(false);
  });

  test("unreadable dates in the page do not corrupt the window", () => {
    const w = dueWindow([...newestPage, NaN], LIMIT + 1, LIMIT);
    expect(Number.isFinite(w.lo)).toBe(true);
    expect(Number.isFinite(w.hi)).toBe(true);
    expect(isProvablyDeleted(ago(90), w)).toBe(false);
  });
});
