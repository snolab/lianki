// Switches show all their states (owner, 2026-11-11 18:50 JST;
// docs/design-principles.md, "A switch shows all its states"): a scan of every
// UI file for controls that show only their current state, held to a known
// list with a reason for each. A new one fails here.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const scanGlob = (pattern: string) => [...new Glob(pattern).scanSync(".")].sort();

/** Every file that can draw a toggle, /dev and /lab included. */
const toggleFiles = () =>
  [
    ...scanGlob("app/**/*.tsx"),
    ...scanGlob("lib/**/*.tsx"),
    ...scanGlob("packages/*/src/**/*.tsx"),
  ].filter((f) => !f.includes("node_modules"));

type Findings = {
  /** `<input type="checkbox">`: shows only its current state. */
  checkboxes: number;
  /** `aria-pressed={x}` on a lone value: a pill or button that only lights up. */
  litPills: number;
  /** role="switch" drawn without the two-part seal (SealSwitch / SealStamp). */
  bareSwitches: number;
};

/**
 * A segmented option, `aria-pressed={a === b}`, is one of several shown side
 * by side and is not counted; neither is a control that draws the shared seal.
 */
function scanToggles(path: string, src = readFileSync(path, "utf8")): Findings {
  const checkboxes = src.match(/type=["']checkbox["']/g)?.length ?? 0;
  let litPills = 0;
  for (const m of src.matchAll(/aria-pressed=\{([^{}]*)\}/g)) {
    if (!/===|!==|[<>]/.test(m[1]!)) litPills++;
  }
  const seal = /\bSeal(Switch|Stamp)\b/.test(src);
  const switches = src.match(/role(=|:\s*)["']switch["']/g)?.length ?? 0;
  return { checkboxes, litPills, bareSwitches: seal ? 0 : switches };
}

/**
 * What still shows only its current state on purpose, each with its reason. An
 * on/off setting is a SealSwitch (or a row that draws SealStamp); a choice of
 * several shows every option, the chosen one in seal red.
 */
const KNOWN: Record<string, Partial<Record<"checkboxes" | "litPills", number>>> = {
  // Selection, not a state: ticking items in a list.
  "app/(app)/data/CardTable.tsx": { checkboxes: 2 }, // select rows / select all
  "app/(app)/lab/ai-vocab/[lang]/AiVocabLangClient.tsx": { checkboxes: 1 }, // pick entries
  "app/(app)/words/WordsClient.tsx": { checkboxes: 1 }, // tick nodes of the list tree
  "app/components/TokenPickers.tsx": { checkboxes: 1, litPills: 2 }, // scopes; expiry options side by side
  "packages/debug-chat/src/DebugPairModal.tsx": { checkboxes: 1 }, // pick pages to pair
  // "Don't ask again" in the leave dialog, mounted in the root layout outside
  // the locale provider (its strings come in as props).
  "app/components/ExternalLinkGuard.tsx": { checkboxes: 2 },
  // The chat package draws with its own strings and inline styles, apart from
  // the app's components.
  "packages/debug-chat/src/VoiceprintPanel.tsx": { checkboxes: 2 },
  "packages/debug-chat/src/StateTree.tsx": { litPills: 1 }, // "needs me" filter in the tree header
  "packages/debug-chat/src/PolishedMark.tsx": { litPills: 1 }, // peek at the raw transcript
  "packages/debug-chat/src/AskCard.tsx": { litPills: 1 }, // answer options, all shown
  "packages/debug-chat/src/GanttFull.tsx": { litPills: 1 }, // the selected bar in a chart
  // One option of a group shown side by side (the "All" chip, multi-select chips).
  "app/(app)/chat/history/HistoryClient.tsx": { litPills: 1 },
  "app/(app)/words/import/AnkiWebDecks.tsx": { litPills: 1 },
  "app/(app)/lab/immersion/ImmersionClient.tsx": { litPills: 1 },
  "app/(app)/dev/users/PregrantPanel.tsx": { litPills: 1 },
  "app/(app)/self-intro/ImportStep.tsx": { litPills: 1 }, // keep / drop pair, both shown
  // Icon toggles: a filled or outlined pin is itself the state.
  "app/(app)/sites/SitesClient.tsx": { litPills: 1 },
  "lib/nav/islands/NavRows.tsx": { litPills: 1 },
  // Show / hide the typed key: a peek, not a setting.
  "app/components/ByokSettings.tsx": { litPills: 1 },
  // The live-view chip also runs in a test harness without the locale provider.
  "app/components/LiveView.tsx": { litPills: 1 },
};

describe("switches show all their states", () => {
  const found = toggleFiles().map((f) => [f, scanToggles(f)] as const);

  it("no new single-state toggle (checkbox for a setting, lit-up pill)", () => {
    const over: string[] = [];
    for (const [f, r] of found)
      for (const k of ["checkboxes", "litPills"] as const) {
        const known = KNOWN[f]?.[k] ?? 0;
        if (r[k] > known) over.push(`${f}: ${k} ${known} → ${r[k]} (use SealSwitch)`);
      }
    expect(over).toEqual([]);
  });

  it("every role=switch draws the two-part seal", () => {
    expect(found.filter(([, r]) => r.bareSwitches).map(([f]) => f)).toEqual([]);
  });

  it("the known list holds only what is still there", () => {
    const byFile = new Map(found);
    const stale: string[] = [];
    for (const [f, kinds] of Object.entries(KNOWN))
      for (const [k, n] of Object.entries(kinds))
        if ((byFile.get(f)?.[k as "checkboxes" | "litPills"] ?? 0) < n!) stale.push(`${f}: ${k}`);
    expect(stale).toEqual([]);
  });

  it("the scanner finds what it is meant to find", () => {
    const src = `<>
      <input type="checkbox" checked={on} />
      <button aria-pressed={on} />
      <button aria-pressed={mode === "a"} />
      <button aria-pressed={n > 2} />
      <div role="switch" aria-checked={on} />
    </>`;
    expect(scanToggles("x.tsx", src)).toEqual({ checkboxes: 1, litPills: 1, bareSwitches: 1 });
    const sealed = `import { SealStamp } from "./SealSwitch";
      <button role="switch" aria-checked={on}><SealStamp on={on} /></button>`;
    expect(scanToggles("y.tsx", sealed).bareSwitches).toBe(0);
  });
});
