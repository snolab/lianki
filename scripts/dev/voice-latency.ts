#!/usr/bin/env bun
/**
 * Collect the debug chat's voice → reply latency records and summarize them
 * per stage (docs/monitoring.md, "Voice latency"). Each spoken line the
 * owner's page sends logs one `{ev: "voice-latency", …}` through devLog,
 * which lands in the Worker's logs; this reads them from a stream, so it
 * waits on input instead of polling anything:
 *
 *   bunx wrangler tail lianki --format json | bun scripts/dev/voice-latency.ts [--n 10]
 *   bun scripts/dev/voice-latency.ts saved-tail.json …     # files instead of stdin
 *
 * Prints each record as it arrives (stderr), and after --n records (default
 * 10) or at the end of the input the markdown table (stdout): n, median, p90
 * and mean ms per stage. Nothing here touches the owner's devices: the
 * samples come from the owner speaking into the mic on their own phone.
 */
import { readFileSync } from "node:fs";
import {
  type LatencyEvent,
  jsonScanner,
  latencyEvents,
  summarize,
  table,
} from "./voice-latency-lib";

const argv = process.argv.slice(2);
const nAt = argv.indexOf("--n");
const want = nAt >= 0 ? Number(argv[nAt + 1]) : 10;
if (!Number.isFinite(want) || want < 1) {
  console.error("usage: … | bun scripts/dev/voice-latency.ts [--n 10] [files…]");
  process.exit(2);
}
const files = argv.filter((a, i) => a !== "--n" && i !== nAt + 1);

const got: LatencyEvent[] = [];
const seen = new Set<string>();
const report = () => {
  console.log(table(summarize(got)));
  console.log(
    `\n${got.length} record(s); ${got.filter((e) => e.replied === false).length} without a reply.`,
  );
};
const scan = jsonScanner((v) => {
  for (const e of latencyEvents(v)) {
    if (e.id && seen.has(e.id)) continue;
    if (e.id) seen.add(e.id);
    got.push(e);
    console.error(
      `#${got.length} total ${e.totalMs ?? "?"} ms · vad ${e.vadMs ?? "?"} · stt ${e.sttMs ?? "?"} (server ${e.sttServerMs ?? "?"}) · hub ${e.hubMs ?? "?"} · agent ${e.agentMs ?? "?"} · voice ${e.voiceMs ?? "?"}`,
    );
    if (got.length >= want) {
      report();
      process.exit(0);
    }
  }
});

if (files.length) {
  for (const f of files) scan(readFileSync(f, "utf8"));
  report();
} else {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c: string) => scan(c));
  process.stdin.on("end", report);
}
