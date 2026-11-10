import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { PILL_CHAT_LOCALES as LOCALES } from "@/src/pill-chat-strings";
import {
  JARGON,
  apiFiles,
  leaves,
  scanApiFile,
  scanUiFile,
  uiFiles,
  userDictionaryFiles,
} from "@/unit/support/ui-scan";

/**
 * Guards from the UI audit of 2026-11-10 (docs/i18n.md, "Guards"): the counts
 * below may only go down. A change that adds a hardcoded UI string, shows a raw
 * error, answers an API error with a sentence, leaves a locale out or puts
 * developer jargon in a user dictionary fails here. When you remove some, lower
 * the baseline: `UPDATE_UI_BASELINE=1 bun test unit/ui-guards.test.ts`.
 */
const BASELINE_PATH = "unit/ui-guards.baseline.json";
type Baseline = {
  literals: Record<string, number>;
  rawErrors: Record<string, number>;
  apiErrors: Record<string, number>;
  missingLocales: string[];
  noDescription: string[];
  jargon: string[];
};
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;

const now: Baseline = {
  literals: {},
  rawErrors: {},
  apiErrors: {},
  missingLocales: [],
  noDescription: [],
  jargon: [],
};
for (const f of uiFiles()) {
  const c = scanUiFile(f);
  if (c.literals) now.literals[f] = c.literals;
  if (c.rawErrors) now.rawErrors[f] = c.rawErrors;
}
for (const f of apiFiles()) {
  const n = scanApiFile(f);
  if (n) now.apiErrors[f] = n;
}

const dictionaries: { file: string; key: string; description?: string; content: unknown }[] = [];
for (const file of userDictionaryFiles()) {
  const mod = (await import(`@/${file}`)) as {
    default?: { key?: string; description?: string; content?: unknown };
  };
  const d = mod.default;
  if (!d?.key) continue;
  dictionaries.push({ file, key: d.key, description: d.description, content: d.content });
}
for (const d of dictionaries) {
  if (!d.description?.trim()) now.noDescription.push(d.key);
  for (const [path, tr] of leaves(d.content)) {
    const missing = LOCALES.filter((l) => typeof tr[l] !== "string");
    if (missing.length) now.missingLocales.push(`${d.key}.${path}`);
    if (typeof tr.en === "string" && JARGON.test(tr.en)) now.jargon.push(`${d.key}.${path}`);
  }
}

if (process.env.UPDATE_UI_BASELINE === "1") {
  const sorted = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).sort());
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        literals: sorted(now.literals),
        rawErrors: sorted(now.rawErrors),
        apiErrors: sorted(now.apiErrors),
        missingLocales: [...new Set(now.missingLocales)].sort(),
        noDescription: [...new Set(now.noDescription)].sort(),
        jargon: [...new Set(now.jargon)].sort(),
      },
      null,
      2,
    )}\n`,
  );
}

/** Files whose count went up against the baseline (a new file counts from 0). */
const grew = (cur: Record<string, number>, base: Record<string, number>) =>
  Object.entries(cur)
    .filter(([f, n]) => n > (base[f] ?? 0))
    .map(([f, n]) => `${f}: ${base[f] ?? 0} → ${n}`);
const added = (cur: string[], base: string[]) => cur.filter((x) => !base.includes(x));

describe("UI guards (ratchet: may only shrink)", () => {
  it("no new hardcoded UI text: strings come from a dictionary", () => {
    expect(grew(now.literals, baseline.literals)).toEqual([]);
  });

  it("no new raw error passthrough (e.message, statusText, digest, `HTTP ${…}`) in the UI", () => {
    expect(grew(now.rawErrors, baseline.rawErrors)).toEqual([]);
  });

  it("API routes answer errors with kebab-case codes, never sentences or e.message", () => {
    expect(grew(now.apiErrors, baseline.apiErrors)).toEqual([]);
  });

  it("every user dictionary key has all 16 locales", () => {
    expect(added(now.missingLocales, baseline.missingLocales)).toEqual([]);
  });

  it("every user dictionary has a description (its context lines)", () => {
    expect(added(now.noDescription, baseline.noDescription)).toEqual([]);
  });

  it("no developer jargon in a user dictionary's English", () => {
    expect(added(now.jargon, baseline.jargon)).toEqual([]);
  });

  it("no two dictionaries share a key", () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const d of dictionaries) {
      const other = seen.get(d.key);
      if (other) dups.push(`${d.key}: ${other} and ${d.file}`);
      else seen.set(d.key, d.file);
    }
    expect(dups).toEqual([]);
  });

  it("the scanner finds what it is meant to find", () => {
    const tsx = `export const A = ({ e }) => (
      <div title="Close the panel" aria-label={t.close}>
        Hello there {e.message} {\`HTTP \${s}\`}
        <b>Lianki</b>
      </div>
    );
    alert("Something broke");`;
    // title, "Hello there", the alert and the `HTTP ${…}` child; "Lianki" is a name.
    expect(scanUiFile("x.tsx", tsx)).toEqual({ literals: 4, rawErrors: 2 });
    // An example address is not text to translate; a sentence around one still is.
    const urls = `<p><input placeholder="https://example.com/list.txt" />https://example.com/a
      <i>Paste https://example.com/a here</i></p>`;
    expect(scanUiFile("y.tsx", urls)).toEqual({ literals: 1, rawErrors: 0 });
    const api = `json({ error: "login-required" }); json({ error: "Login required" }); json({ error: e.message }); json({ error: \`bad \${x}\` })`;
    expect(scanApiFile("route.ts", api)).toBe(3);
    expect(JARGON.test("Word lists need the D1 backend")).toBe(true);
    expect(JARGON.test("Your API key stays in this browser")).toBe(false);
  });
});
