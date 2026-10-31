/**
 * The STT bench's pure parts (scripts/dev/stt-bench.ts runs it): the code it
 * runs on the owner's page, and the scoring — character error rate against a
 * reference, agreement between models, latency and cost.
 */
import { STT_PRICE_PER_MIN, type SttModel } from "../../lib/stt";
import type { ClipEntry } from "./clip-sink";

/** One transcription, as the page reports it. */
export type BenchResult = {
  clip: string;
  model: string;
  text: string;
  ms: number;
  language?: string;
  error?: string;
};

/** What is compared: case, width, spaces and punctuation do not count. */
export function normalize(s: string): string[] {
  return [
    ...s
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{P}\p{S}\s]+/gu, ""),
  ];
}

/** Levenshtein distance between two character lists. */
export function distance(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Character error rate of `hyp` against `ref` (0 = perfect; can pass 1). */
export function cer(ref: string, hyp: string): number {
  const r = normalize(ref);
  return distance(r, normalize(hyp)) / Math.max(1, r.length);
}

/** How alike two transcripts are, 0–1 (1 = the same characters). */
export function agreement(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  const n = Math.max(x.length, y.length);
  return n === 0 ? 1 : 1 - distance(x, y) / n;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round = (x: number | null, d = 3) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export type ModelSummary = {
  model: string;
  runs: number;
  errors: number;
  meanMs: number | null;
  /** Mean CER over the clips that have a reference. */
  meanCer: number | null;
  /** Mean agreement with the other models' transcripts of the same clips. */
  agreement: number | null;
  pricePerMin: number | null;
  /** What this run cost with this model, from the clips' durations. */
  cost: number | null;
};
export type Bench = {
  models: string[];
  clips: {
    clip: string;
    durationMs: number;
    ref?: string;
    by: Record<
      string,
      { text: string; ms: number; error?: string; cer?: number; language?: string }
    >;
  }[];
  summary: ModelSummary[];
};

/** Score a run: per clip and model, and per model overall. */
export function aggregate(results: BenchResult[], clips: ClipEntry[]): Bench {
  const models = [...new Set(results.map((r) => r.model))];
  const info = new Map(clips.map((c) => [c.name, c]));
  const byClip = new Map<string, Bench["clips"][number]>();
  for (const r of results) {
    const c = info.get(r.clip);
    let row = byClip.get(r.clip);
    if (!row) {
      row = {
        clip: r.clip,
        durationMs: c?.durationMs ?? 0,
        ...(c?.ref ? { ref: c.ref } : {}),
        by: {},
      };
      byClip.set(r.clip, row);
    }
    row.by[r.model] = {
      text: r.text,
      ms: r.ms,
      ...(r.error ? { error: r.error } : {}),
      ...(r.language ? { language: r.language } : {}),
      ...(row.ref !== undefined && !r.error ? { cer: round(cer(row.ref, r.text)) as number } : {}),
    };
  }
  const rows = [...byClip.values()];
  const summary = models.map((model): ModelSummary => {
    const mine = rows.map((row) => row.by[model]).filter(Boolean);
    const ok = mine.filter((x) => !x.error);
    const agree: number[] = [];
    for (const row of rows) {
      const me = row.by[model];
      if (!me || me.error) continue;
      for (const other of models)
        if (other !== model && row.by[other] && !row.by[other].error)
          agree.push(agreement(me.text, row.by[other].text));
    }
    const price = STT_PRICE_PER_MIN[model as SttModel] ?? null;
    const minutes =
      rows.filter((row) => row.by[model]).reduce((s, row) => s + row.durationMs, 0) / 60_000;
    return {
      model,
      runs: mine.length,
      errors: mine.length - ok.length,
      meanMs: round(mean(ok.map((x) => x.ms)), 0),
      meanCer: round(mean(ok.flatMap((x) => (x.cer === undefined ? [] : [x.cer])))),
      agreement: round(mean(agree)),
      pricePerMin: price,
      cost: price === null ? null : round(price * minutes, 6),
    };
  });
  return { models, clips: rows, summary };
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The bench as markdown: a summary table, then clip × model transcripts. */
export function markdown(b: Bench, title = "STT bench"): string {
  const out = [
    `# ${title}`,
    "",
    "| model | runs | errors | mean ms | mean CER | agreement | USD / audio min | this run USD |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const s of b.summary)
    out.push(
      `| ${s.model} | ${s.runs} | ${s.errors} | ${s.meanMs ?? "–"} | ${s.meanCer ?? "–"} | ${s.agreement ?? "–"} | ${s.pricePerMin ?? "not listed"} | ${s.cost ?? "–"} |`,
    );
  out.push(
    "",
    "CER needs a `<clip>.ref.txt` next to the clip; agreement is with the other models.",
    "",
  );
  out.push(
    `| clip | ref | ${b.models.join(" | ")} |`,
    `| --- | --- |${b.models.map(() => " --- |").join("")}`,
  );
  for (const row of b.clips)
    out.push(
      `| ${row.clip} (${(row.durationMs / 1000).toFixed(1)} s) | ${cell(row.ref ?? "")} | ${b.models
        .map((m) => {
          const x = row.by[m];
          if (!x) return "";
          if (x.error) return `error: ${cell(x.error)}`;
          return `${cell(x.text)} (${x.ms} ms${x.cer === undefined ? "" : `, CER ${x.cer}`})`;
        })
        .join(" | ")} |`,
    );
  return `${out.join("\n")}\n`;
}

/**
 * The code run on the owner's page (through eval.ts), with the sink's read
 * key (clip-sink.ts sinkKeys; it travels only over the owner's eval grant): fetch each clip from the
 * dev server, transcribe it with each model through the page's own session,
 * and post the raw results back to the dev server (an eval answer is too small
 * to carry them). Returns how many transcriptions it made.
 */
export function benchCode(sink: string, models: string[], run: string, key = ""): string {
  return `
const sink = ${JSON.stringify(sink.replace(/\/+$/, ""))};
const models = ${JSON.stringify(models)};
const auth = { authorization: ${JSON.stringify(`Bearer ${key}`)} };
const { clips } = await (await fetch(sink + "/clips/index.json", { headers: auth })).json();
const results = [];
for (const c of clips) {
  const audio = await (await fetch(sink + "/clips/" + c.file, { headers: auth })).blob();
  for (const model of models) {
    const t0 = performance.now();
    try {
      const res = await fetch("/api/debug/stt?model=" + encodeURIComponent(model), {
        method: "POST", body: audio, headers: { "content-type": c.mime || audio.type },
      });
      const out = await res.json();
      results.push(res.ok
        ? { clip: c.name, model, text: out.text, ms: out.ms ?? Math.round(performance.now() - t0), language: out.language }
        : { clip: c.name, model, text: "", ms: Math.round(performance.now() - t0), error: out.error || String(res.status) });
    } catch (e) {
      results.push({ clip: c.name, model, text: "", ms: 0, error: String(e) });
    }
  }
}
await fetch(sink + "/clips/bench?run=${run}", { method: "POST", headers: auth, body: JSON.stringify({ run: "${run}", results }) });
return { clips: clips.length, results: results.length };
`;
}
