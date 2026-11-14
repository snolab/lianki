import { describe, expect, test } from "bun:test";
import {
  CLAUDE_LINE,
  backMergeBody,
  backMergeTitle,
  checkState,
  groupCommits,
  needsQueue,
  neutralizeClosers,
  parseArgs,
  parseSubject,
  plan,
  prAction,
  releaseBody,
  releaseTitle,
  retryable,
  staleComment,
  titleDate,
  utcDate,
} from "../scripts/release/daily-pr-lib";

const c = (subject: string, sha = "abcdef1234567") => ({ sha, subject });

describe("dates and titles", () => {
  test("utcDate is the UTC calendar day", () => {
    expect(utcDate(new Date("2026-11-14T19:00:00Z"))).toBe("2026-11-14");
    expect(utcDate(new Date("2026-11-14T23:59:59-05:00"))).toBe("2026-11-15");
  });
  test("titles round-trip their date", () => {
    expect(releaseTitle("2026-11-14")).toBe("Release 2026-11-14");
    expect(backMergeTitle("2026-11-14")).toBe("Back-merge prod 2026-11-14");
    expect(titleDate("Release 2026-11-14")).toBe("2026-11-14");
    expect(titleDate("Back-merge prod 2026-11-13")).toBe("2026-11-13");
    expect(titleDate("Release notes")).toBeNull();
  });
});

describe("parseSubject", () => {
  test("type with scope", () =>
    expect(parseSubject("feat(voice)!: kana")).toEqual({ heading: "New", text: "voice: kana" }));
  test("type without scope", () =>
    expect(parseSubject("fix: crash")).toEqual({ heading: "Fixes", text: "crash" }));
  test("several types share a heading", () => {
    expect(parseSubject("chore: x").heading).toBe("Maintenance");
    expect(parseSubject("ci: x").heading).toBe("Maintenance");
    expect(parseSubject("style: x").heading).toBe("Refactors");
  });
  test("unknown type or plain subject is Other, untouched", () => {
    expect(parseSubject("wip: x")).toEqual({ heading: "Other", text: "wip: x" });
    expect(parseSubject("  Mini apps (#961) ")).toEqual({
      heading: "Other",
      text: "Mini apps (#961)",
    });
  });
});

describe("neutralizeClosers", () => {
  test("closing keywords lose their effect", () => {
    expect(neutralizeClosers("fixes #12 and Closes: #3")).toBe("fixes (#12) and Closes: (#3)");
    expect(neutralizeClosers("resolved snolab/lianki#9")).toBe("resolved (snolab/lianki#9)");
  });
  test("other references stay", () =>
    expect(neutralizeClosers("Mini apps (#961)")).toBe("Mini apps (#961)"));
});

describe("groupCommits", () => {
  test("fixed heading order, short shas, back-merges left out", () => {
    const g = groupCommits([
      c("misc thing", "1111111aaaa"),
      c("fix: b", "2222222bbbb"),
      c("feat: a", "3333333cccc"),
      c("Back-merge prod 2026-11-13 (#970)"),
      c("fix: c fixes #4", "4444444dddd"),
    ]);
    expect(g).toEqual([
      { heading: "New", items: ["a (3333333)"] },
      { heading: "Fixes", items: ["b (2222222)", "c fixes (#4) (4444444)"] },
      { heading: "Other", items: ["misc thing (1111111)"] },
    ]);
  });
});

describe("bodies", () => {
  test("release body: count, groups, the closing line last", () => {
    const b = releaseBody({
      date: "2026-11-14",
      base: "prod",
      head: "main",
      commits: [c("feat: a")],
    });
    expect(b).toContain("Today's release: 1 change from `main`");
    expect(b).toContain("### New\n\n- a (abcdef1)");
    expect(b.endsWith(`\n${CLAUDE_LINE}`)).toBe(true);
    expect(b).not.toMatch(/\b(fixes|closes|resolves) #\d/i);
  });
  test("plural, and long lists are cut", () => {
    const many = Array.from({ length: 5 }, (_, i) => c(`fix: n${i}`));
    const b = releaseBody({ date: "d", base: "prod", head: "main", commits: many, max: 2 });
    expect(b).toContain("5 changes");
    expect(b).toContain("- n1");
    expect(b).not.toContain("- n2");
    expect(b).toContain("…and 3 more");
  });
  test("cut across groups drops a later group's heading", () => {
    const b = releaseBody({
      date: "d",
      base: "prod",
      head: "main",
      commits: [c("feat: a"), c("fix: b")],
      max: 1,
    });
    expect(b).not.toContain("### Fixes");
  });
  test("back-merge body names both branches and ends with the line", () => {
    const b = backMergeBody({ date: "d", base: "main", head: "prod", commits: [c("fix: hot")] });
    expect(b).toContain("straight to `prod`");
    expect(b).toContain("- hot (abcdef1)");
    expect(b.endsWith(CLAUDE_LINE)).toBe(true);
  });
});

describe("plan", () => {
  test("no prod: nothing", () =>
    expect(plan({ prodExists: false, prodHasOwn: false, mainAhead: true }).kind).toBe("nothing"));
  test("prod's own changes go back first", () =>
    expect(plan({ prodExists: true, prodHasOwn: true, mainAhead: true }).kind).toBe("back-merge"));
  test("main ahead: release", () =>
    expect(plan({ prodExists: true, prodHasOwn: false, mainAhead: true }).kind).toBe("release"));
  test("level: nothing", () =>
    expect(plan({ prodExists: true, prodHasOwn: false, mainAhead: false })).toEqual({
      kind: "nothing",
      reason: "prod already has everything on main",
    }));
});

describe("prAction", () => {
  const pr = (title: string) => ({ number: 1, title, url: "u" });
  test("none open: create", () =>
    expect(prAction(undefined, "2026-11-14")).toEqual({ kind: "create" }));
  test("today's: update, not stale", () =>
    expect(prAction(pr("Release 2026-11-14"), "2026-11-14")).toEqual({
      kind: "update",
      stale: false,
      since: "2026-11-14",
    }));
  test("yesterday's: update and say so", () => {
    const a = prAction(pr("Release 2026-11-13"), "2026-11-14");
    expect(a).toEqual({ kind: "update", stale: true, since: "2026-11-13" });
    expect(staleComment("2026-11-13", "2026-11-14", "release")).toContain(
      "release from 2026-11-13 did not merge",
    );
  });
  test("a hand-titled PR is stale with no date", () => {
    expect(prAction(pr("whatever"), "2026-11-14")).toEqual({
      kind: "update",
      stale: true,
      since: null,
    });
    expect(staleComment(null, "2026-11-14", "back-merge")).toContain(
      "back-merge from an earlier run",
    );
  });
});

describe("checkState", () => {
  const r = (status: string, conclusion: string | null, id: number, name = "Typecheck + unit") => ({
    name,
    status,
    conclusion,
    id,
  });
  test("missing", () =>
    expect(checkState([r("completed", "success", 1, "other")])).toBe("missing"));
  test("newest run wins", () => {
    expect(checkState([r("completed", "failure", 1), r("completed", "success", 2)])).toBe(
      "success",
    );
    expect(checkState([r("completed", "success", 1), r("in_progress", null, 2)])).toBe("pending");
    expect(checkState([r("completed", "cancelled", 3), r("completed", "success", 2)])).toBe(
      "failure",
    );
  });
  test("runs without ids still count", () =>
    expect(
      checkState([{ name: "Typecheck + unit", status: "completed", conclusion: "success" }]),
    ).toBe("success"));
});

describe("error text", () => {
  test("retryable", () => {
    expect(retryable("2 of 2 required status checks are expected")).toBe(true);
    expect(retryable("Pull request is not mergeable")).toBe(false);
  });
  test("needsQueue", () => {
    expect(needsQueue("Changes must be made through the merge queue")).toBe(true);
    expect(needsQueue("conflict")).toBe(false);
  });
});

describe("parseArgs", () => {
  test("defaults", () =>
    expect(parseArgs([], {})).toEqual({
      dryRun: false,
      base: "prod",
      head: "main",
      repo: "snolab/lianki",
      waitMin: 45,
    }));
  test("flags", () =>
    expect(
      parseArgs(
        ["--dry-run", "--base", "p", "--head", "h", "--repo", "o/r", "--wait-min", "0"],
        {},
      ),
    ).toEqual({ dryRun: true, base: "p", head: "h", repo: "o/r", waitMin: 0 }));
  test("env", () => {
    const a = parseArgs([], {
      DRY_RUN: "true",
      LIANKI_RELEASE_BRANCH: "release",
      GITHUB_REPOSITORY: "x/y",
      LIANKI_RELEASE_WAIT_MIN: "10",
    });
    expect(a).toMatchObject({ dryRun: true, base: "release", repo: "x/y", waitMin: 10 });
  });
  test("a bad wait falls back", () => {
    expect(parseArgs(["--wait-min", "soon"], {}).waitMin).toBe(45);
    expect(parseArgs([], { LIANKI_RELEASE_WAIT_MIN: "-3" }).waitMin).toBe(45);
  });
});
