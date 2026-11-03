import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { treeFrontier } from "@lianki/debug-chat/frontier-view";
import { frontier, parseTreeDoc } from "@lianki/debug-chat/state-tree";
import { overlayProgress } from "@/lib/progress-tree";
import { mergeProgress, parseProgressReport, type ProgressEntry } from "@/lib/progress";

const entry = (b: Record<string, unknown>, at = 1): ProgressEntry =>
  mergeProgress(
    undefined,
    parseProgressReport({ task: "t", status: "doing", agent: "a", ...b }) as never,
    at,
  );

const MD = `# T

≈ doing: 多线并进
≈en doing: Many fronts at once

## /words
≈ doing: 当务之急
- [x] iOS glass: first card under the toolbar (#299) (done 2026-10-30T01:12)
- [~] Old swipe item, never reported @main-lane
- [ ] Swipe @main-lane
  - [ ] Native fix

## Dev tools
- [ ] Previews
`;

describe("the minimized bar's frontier (treeFrontier)", () => {
  const base = parseTreeDoc(MD);

  it("shows nothing from the bundled outline: no finished item, no stale [~]", () => {
    expect(treeFrontier(base, { locale: "zh" })).toBeUndefined();
    // The repo's own tree, as shipped: nothing is live, so nothing shows.
    const repo = parseTreeDoc(readFileSync("docs/state-tree.md", "utf8"));
    expect(treeFrontier(repo, { locale: "zh" })).toBeUndefined();
    expect(treeFrontier(null)).toBeUndefined();
  });

  it("shows one ▶ line for live in-progress work, as the ≈ summary in the page's language", () => {
    const live = overlayProgress(base, [entry({ id: "/words/swipe", task: "Swipe" })]);
    const f = treeFrontier(live, { locale: "zh", inProgress: "进行中" })!;
    expect(Object.keys(f)).toEqual(["doing"]);
    expect(f.doing!.text).toBe("当务之急"); // the /words ≈, not the title "Swipe"
    expect(f.doing!.count).toBe(1);
    expect(f.doing!.items!.map((i) => i.title)).toEqual(["Swipe"]); // only on tap
  });

  it("without a ≈ for it, says 'in progress' in the page's language, never a title", () => {
    const live = overlayProgress(base, [entry({ id: "/dev/previews", task: "Previews" })]);
    expect(treeFrontier(live, { locale: "zh", inProgress: "进行中" })!.doing!.text).toBe(
      "多线并进",
    );
    const bare = parseTreeDoc("## Dev tools\n- [ ] Previews\n");
    const one = overlayProgress(bare, [entry({ id: "/dev/previews", task: "Previews" })]);
    expect(treeFrontier(one, { locale: "zh", inProgress: "进行中" })!.doing!.text).toBe("进行中");
  });

  it("a live item reported done does not show", () => {
    const live = overlayProgress(base, [
      entry({ id: "/words/swipe", task: "Swipe", status: "done" }),
    ]);
    expect(treeFrontier(live, { locale: "zh" })).toBeUndefined();
  });

  it("frontier({live}) keeps only hub-reported items; the full frontier is unchanged", () => {
    const live = overlayProgress(base, [entry({ id: "/words/swipe", task: "Swipe" })]);
    expect(frontier(live, { live: true }).done).toBeUndefined();
    expect(frontier(live).done?.title).toContain("iOS glass"); // the tree view still marks it
  });
});
