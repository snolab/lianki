import { expect, test } from "bun:test";
import { createSequencer } from "../lib/words/sequence";

function rig(partTimeoutMs?: (part: string) => number) {
  const log: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const dones = new Map<string, (p: boolean) => void>();
  const seq = createSequencer<string>({
    say: (p, done) => {
      log.push(`say:${p}`);
      if (p.startsWith("ok")) return done(true);
      dones.set(p, done); // "stuck": never reports done by itself
    },
    cancel: () => log.push("cancel"),
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (t) => void timers.delete(t as number),
    partTimeoutMs,
  });
  /** Run the earliest timer with `ms`. */
  const run = (ms: number) => {
    const hit = [...timers].find(([, t]) => t.ms === ms);
    if (!hit) throw Error(`no ${ms} ms timer`);
    timers.delete(hit[0]);
    hit[1].fn();
  };
  return { seq, log, timers, run, dones };
}

test("a part that never reports done is cut and skipped after the timeout", () => {
  const r = rig(() => 30000);
  r.seq.play(["stuck", "ok-example", "ok-meaning"]);
  expect(r.log.slice(-1)).toEqual(["say:stuck"]);
  r.run(30000);
  expect(r.log.slice(-1)).toEqual(["cancel"]);
  r.run(150); // the gap
  expect(r.log).toContain("say:ok-example");
  r.run(150);
  expect(r.log.slice(-1)).toEqual(["say:ok-meaning"]);
  expect(r.seq.playing()).toBeNull();
  // The stuck part's late done changes nothing.
  r.dones.get("stuck")!(true);
  expect(r.timers.size).toBe(0);
});

test("a part that ends in time clears its watchdog", () => {
  const r = rig(() => 30000);
  r.seq.play(["slow", "ok"]);
  r.dones.get("slow")!(true);
  expect([...r.timers.values()].map((t) => t.ms)).toEqual([150]);
});

test("stop and a new play clear the watchdog; no timeout means no watchdog", () => {
  const r = rig(() => 30000);
  r.seq.play(["slow"]);
  r.seq.stop();
  expect(r.timers.size).toBe(0);
  r.seq.play(["slow"]);
  r.seq.play(["slow2"]);
  expect([...r.timers.values()].map((t) => t.ms)).toEqual([30000]);
  const n = rig(() => 0);
  n.seq.play(["slow"]);
  expect(n.timers.size).toBe(0);
  const u = rig();
  u.seq.play(["slow"]);
  expect(u.timers.size).toBe(0);
});

test("an explicit download can wait while ordinary parts keep their watchdog", () => {
  const r = rig((part) => (part === "original-download" ? 0 : 30000));
  r.seq.play(["original-download", "ordinary"]);
  expect(r.timers.size).toBe(0);
  r.dones.get("original-download")!(true);
  r.run(150);
  expect([...r.timers.values()].map((t) => t.ms)).toEqual([30000]);
  r.seq.stop();
  expect(r.timers.size).toBe(0);
});
