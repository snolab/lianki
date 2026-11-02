import { describe, expect, it } from "bun:test";
import {
  jsonScanner,
  latencyEvents,
  quantile,
  summarize,
  table,
} from "@/scripts/dev/voice-latency-lib";

const rec = (id: string, totalMs: number, vadMs = 1_400) => ({
  ev: "voice-latency",
  id,
  totalMs,
  vadMs,
});
/** How `wrangler tail --format json` carries one devLog line (route: console.log of dev.client). */
const tailEvent = (r: object) => ({
  outcome: "ok",
  logs: [
    {
      level: "log",
      message: [
        JSON.stringify({
          msg: "dev.client",
          ua: "iPhone",
          body: JSON.stringify({ at: "x", ...r }),
        }),
      ],
    },
  ],
});

describe("voice-latency collection", () => {
  it("finds records in pretty-printed tail events split across chunks, and in bare lines", () => {
    const text = `${JSON.stringify(tailEvent(rec("a", 5_000)), null, 2)}\nnoise {not json}\n${JSON.stringify(rec("b", 7_000))}\n(log) ${JSON.stringify({ msg: "dev.client", body: JSON.stringify(rec("c", 6_000)) })}`;
    const found: unknown[] = [];
    const scan = jsonScanner((v) => found.push(...latencyEvents(v)));
    for (let i = 0; i < text.length; i += 7) scan(text.slice(i, i + 7));
    expect(found.map((e) => (e as { id: string }).id)).toEqual(["a", "b", "c"]);
  });

  it("ignores other events and braces inside strings", () => {
    const found: unknown[] = [];
    const scan = jsonScanner((v) => found.push(...latencyEvents(v)));
    scan(JSON.stringify({ ev: "voice-utt", text: "a } b {" }));
    scan(JSON.stringify(tailEvent({ ev: "voice-out" })));
    expect(found).toEqual([]);
  });

  it("summarizes per stage: n, median, p90, mean", () => {
    const evs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => rec(String(i), i * 1_000));
    const rows = summarize(evs);
    expect(rows.map((r) => r.stage)).toEqual(["vadMs", "totalMs"]);
    expect(rows[1]).toEqual({ stage: "totalMs", n: 10, median: 5_000, p90: 9_000, mean: 5_500 });
    expect(table(rows)).toContain("| totalMs | 10 | 5000 | 9000 | 5500 |");
    expect(quantile([], 0.5)).toBeNaN();
  });
});
