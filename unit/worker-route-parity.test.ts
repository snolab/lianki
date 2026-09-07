import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Drift guard between the two FSRS backends.
 *
 * apps/api/src/worker/fsrs.ts calls itself "a faithful CF-native port of
 * app/fsrs.ts", but it silently lacked /api/fsrs/speed-markers and
 * PATCH /api/fsrs/notes. The userscript calls speed-markers every 30 s, so after
 * the cf-native cutover marker sync would have 404'd on every user and markers
 * would have stopped leaving the browser — with nothing failing loudly enough to
 * notice. This test makes the next omission fail in CI instead of in production.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** `"POST /api/fsrs/speed-markers(?:/|$|\\?)": …` → `POST /api/fsrs/speed-markers` */
function nextRoutes(): Set<string> {
  const src = read("app/fsrs.ts");
  const out = new Set<string>();
  for (const m of src.matchAll(/"(GET|POST|PATCH|DELETE) (\/api\/fsrs\/[a-z-]+)/g))
    out.add(`${m[1]} ${m[2]}`);
  return out;
}

/**
 * `app.post("/api/fsrs/speed-markers", …)` → `POST /api/fsrs/speed-markers`
 *
 * Scans every worker module that mounts /api/fsrs routes, not just fsrs.ts —
 * /watch is mounted from watch.ts, and looking at one file made the check report
 * a route as missing when it was merely somewhere else.
 */
function workerRoutes(): Set<string> {
  const src = ["apps/api/src/worker/fsrs.ts", "apps/api/src/worker/watch.ts"].map(read).join("\n");
  const out = new Set<string>();
  for (const m of src.matchAll(/app\.(get|post|patch|delete)\(\s*"(\/api\/fsrs\/[a-z-]+)/g))
    out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

// Routes the worker deliberately does not carry: server-rendered HTML/redirect
// endpoints from the pre-SPA era, not part of the userscript's API surface.
const NOT_PORTED = new Set(["GET /api/fsrs/repeat", "GET /api/fsrs/next"]);

// Landed on main after the worker port and not yet carried over. Unlike
// NOT_PORTED these are real debt: they are called from app/(app)/data, so the
// data page loses list/export/bulk-edit the moment the worker serves the app.
// The userscript does not touch them, which is why this is a separate set —
// deleting an entry here should mean the route now exists in the worker.
const PORT_PENDING = new Set([
  "GET /api/fsrs/list",
  "GET /api/fsrs/stats",
  "POST /api/fsrs/bulk-delete",
  "POST /api/fsrs/bulk-upsert",
]);

describe("worker ↔ next FSRS route parity", () => {
  test("every userscript-facing route in app/fsrs.ts exists in the CF worker", () => {
    const missing = [...nextRoutes()].filter(
      (r) => !workerRoutes().has(r) && !NOT_PORTED.has(r) && !PORT_PENDING.has(r),
    );
    expect(missing).toEqual([]);
  });

  test("the routes the userscript actually calls are present in the worker", () => {
    // Named explicitly so a rename in app/fsrs.ts cannot make the test above
    // pass vacuously by shrinking both sides at once.
    for (const route of [
      "GET /api/fsrs/speed-markers",
      "POST /api/fsrs/speed-markers",
      "POST /api/fsrs/add",
      "GET /api/fsrs/due",
      "PATCH /api/fsrs/notes",
      "PATCH /api/fsrs/update-url",
      "GET /api/fsrs/delete",
    ])
      expect(workerRoutes()).toContain(route);
  });

  test("the userscript calls nothing the worker lacks", () => {
    const called = new Set<string>();
    for (const m of read("src/lianki.user.ts").matchAll(/["'`](\/api\/fsrs\/[a-z-]+)/g))
      called.add(m[1]);
    const worker = [...workerRoutes()].map((r) => r.split(" ")[1]);
    expect([...called].filter((p) => !worker.includes(p))).toEqual([]);
  });
});
