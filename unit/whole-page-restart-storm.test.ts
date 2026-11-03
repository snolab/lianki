import { describe, expect, test } from "bun:test";
import {
  RestartStorm,
  STORM_COOLDOWN_MS,
  STORM_RESTARTS,
  STORM_WINDOW_MS,
  STORM_YOUNG_MS,
  restartScanner,
} from "../scripts/dev/whole-page-guard";

/**
 * What next dev sent a page on every load during the storm of 2026-11-03
 * (captured on 127.0.0.1:3101, 14:00 JST): the runtime chunk list's update
 * was a `restart`, which the page's runtime turns into location.reload().
 */
const RESTART_MSG =
  '{"type":"turbopack-message","data":[{"resource":{"path":"static/chunks/_1anvha4rlo79g._.js","headers":null},"type":"restart","issues":[],"diagnostics":[]}],"hmrVersion":"119"}';
const BUILT_MSG = '{"type":"built","hash":"1","errors":[],"warnings":[]}';

/** A server-to-browser WebSocket text frame (FIN, opcode 1, unmasked). */
function frame(text: string): Buffer {
  const body = Buffer.from(text);
  const len = body.length;
  const head =
    len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 0xff]);
  return Buffer.concat([head, body]);
}

describe("whole-page guard: Turbopack restart storm", () => {
  test("counts restart messages in the HMR byte stream", () => {
    const scan = restartScanner();
    expect(scan(frame(BUILT_MSG))).toBe(0);
    expect(scan(Buffer.concat([frame(RESTART_MSG), frame(BUILT_MSG), frame(RESTART_MSG)]))).toBe(2);
  });

  test("a message cut anywhere by TCP is counted once", () => {
    const bytes = Buffer.concat([frame(BUILT_MSG), frame(RESTART_MSG), frame(BUILT_MSG)]);
    for (let cut = 1; cut < bytes.length; cut++) {
      const scan = restartScanner();
      expect(scan(bytes.subarray(0, cut)) + scan(bytes.subarray(cut))).toBe(1);
    }
    // One byte at a time.
    const scan = restartScanner();
    let n = 0;
    for (const b of bytes) n += scan(Buffer.from([b]));
    expect(n).toBe(1);
  });

  test("other updates and issue texts are not restarts", () => {
    const scan = restartScanner();
    const partial =
      '{"type":"turbopack-message","data":[{"resource":{"path":"static/chunks/x.js"},"type":"partial","instruction":{}}],"hmrVersion":"3"}';
    expect(scan(frame(partial))).toBe(0);
    expect(scan(frame('{"type":"building"}'))).toBe(0);
  });

  test("a publish (one restart per open page) is not a storm, however many pages", () => {
    const storm = new RestartStorm();
    const now = 600_000;
    // Ten pages open for a minute or more, one real runtime change: one each.
    for (let p = 0; p < 10; p++) expect(storm.note(1, now, now - 60_000 - p * 1000)).toBe(false);
    // A later publish, same pages.
    for (let p = 0; p < 10; p++)
      expect(storm.note(1, now + STORM_WINDOW_MS + 1, now - 60_000)).toBe(false);
  });

  test("a page reloading every second is a storm: restart next dev once", () => {
    const storm = new RestartStorm();
    const fired: number[] = [];
    // Each load opens a new socket; its restart comes ~0.3 s later.
    for (let t = 0; t < 60_000; t += 1000) if (storm.note(1, t + 300, t)) fired.push(t);
    expect(fired).toEqual([(STORM_RESTARTS - 1) * 1000]);
  });

  test("a socket opened just before a publish counts, but alone is no storm", () => {
    const storm = new RestartStorm();
    expect(storm.note(1, STORM_YOUNG_MS - 1, 0)).toBe(false);
    expect(storm.note(1, STORM_YOUNG_MS, 0)).toBe(false); // old enough to be ignored
  });

  test("still storming after the cooldown: restart again, not sooner", () => {
    const storm = new RestartStorm();
    const fired: number[] = [];
    for (let t = 0; t < STORM_COOLDOWN_MS * 2; t += 500)
      if (storm.note(1, t + 200, t)) fired.push(t);
    expect(fired.length).toBe(2);
    expect(fired[1] - fired[0]).toBeGreaterThanOrEqual(STORM_COOLDOWN_MS);
  });
});
