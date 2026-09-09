import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "bun:test";

/**
 * The sync queue's retry rule.
 *
 * Measured on a real browser before this existed: 73 of 230 cards sat unsynced,
 * and one queue item had failed 237 times against a retry cap of 5. The failures
 * were HTTP 409 ("Server has newer version") and 404 — both permanent — but the
 * loop treated every failure as transient and only counted. The count itself was
 * unreliable too: `retries` is a read-modify-write on GM storage shared by every
 * open tab, so concurrent tabs lost increments and dead items retried unbounded,
 * jamming the queue behind them.
 *
 * Classifying instead of counting fixes both: a permanent failure never enters
 * the counter at all, so the race cannot keep it alive.
 *
 * Runs against the BUILT public/lianki.user.js, since that is what users install.
 */
const BUILT = readFileSync(join(process.cwd(), "public/lianki.user.js"), "utf-8");

function extract(name: string) {
  const start = BUILT.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in the built userscript`);
  const open = BUILT.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < BUILT.length; i++) {
    if (BUILT[i] === "{") depth++;
    else if (BUILT[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  return BUILT.slice(start, end);
}

const isPermanentSyncFailure = new Function(
  `${extract("isPermanentSyncFailure")}; return isPermanentSyncFailure;`,
)() as (status: unknown) => boolean;

describe("isPermanentSyncFailure", () => {
  it("treats a 409 as permanent — the server already has a newer version", () => {
    // This is the one that jammed the real queue 237 times.
    expect(isPermanentSyncFailure(409)).toBe(true);
  });

  it("treats a 404 as permanent — the note is gone", () => {
    expect(isPermanentSyncFailure(404)).toBe(true);
  });

  it("treats a malformed or gone request as permanent", () => {
    for (const s of [400, 410, 422]) expect(isPermanentSyncFailure(s)).toBe(true);
  });

  it("keeps retrying when NOT SIGNED IN — a guest's reviews must survive", () => {
    // A guest reviews cards before ever having an account; those queued reviews
    // wait for sign-in. The first version of this rule dropped 401 as
    // "permanent", which silently destroyed the work of every signed-out user.
    // The guest suite caught it; this pins it.
    expect(isPermanentSyncFailure(401)).toBe(false);
    expect(isPermanentSyncFailure(403)).toBe(false);
  });

  it("keeps retrying the 4xx that literally mean 'try again'", () => {
    expect(isPermanentSyncFailure(408)).toBe(false); // request timeout
    expect(isPermanentSyncFailure(429)).toBe(false); // rate limited
  });

  it("keeps retrying server failures", () => {
    for (const s of [500, 502, 503, 504]) expect(isPermanentSyncFailure(s)).toBe(false);
  });

  it("keeps retrying a network failure, which carries no status at all", () => {
    // gmFetch rejects without a status when the request never reached a server.
    // Dropping those would silently discard reviews made while offline.
    expect(isPermanentSyncFailure(undefined)).toBe(false);
    expect(isPermanentSyncFailure(0)).toBe(false);
    expect(isPermanentSyncFailure(null)).toBe(false);
  });
});

describe("the built script wires the rule in", () => {
  it("routes a 409 to adopting the server's version, not to the retry counter", () => {
    // The 409 body already carries card/log/serverHLC, so the losing client can
    // converge without another round trip.
    expect(BUILT).toContain("adoptServerVersion");
    // The CALL site, not the definition — `indexOf` on the bare name finds the
    // function itself, which proves nothing about how it is used.
    const call = BUILT.indexOf("= isPermanentSyncFailure(status)");
    expect(call).toBeGreaterThan(-1);
    const branch = BUILT.slice(call, call + 500);
    expect(branch).toContain("409");
    expect(branch).toContain("adoptServerVersion");
    // and the 409 path must not touch the retry counter
    expect(branch.slice(0, branch.indexOf("retries"))).toContain("removeFromQueue");
  });

  it("attaches the status to API errors, or nothing could classify them", () => {
    // Only 401 used to carry a status; everything else threw a bare "HTTP nnn".
    expect(BUILT).toMatch(/e\.status = status/);
  });
});

describe("unreachable-page probe", () => {
  /** Lift probeUrl out of the build and drive it with a fake api(). */
  function makeProbe(api: (path: string, opts?: unknown) => Promise<unknown>) {
    const start = BUILT.indexOf("async function probeUrl(");
    if (start === -1) throw new Error("probeUrl not found in the built userscript");
    const open = BUILT.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < BUILT.length; i++) {
      if (BUILT[i] === "{") depth++;
      else if (BUILT[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    return new Function("api", `${BUILT.slice(start, end)}; return probeUrl;`)(api) as (
      u: string,
      t?: number,
    ) => Promise<{ ok: boolean; finalUrl?: string; status?: number; reason?: string }>;
  }

  it("asks the server, not the userscript manager", async () => {
    // The bug this replaced: managers gate cross-origin requests on @connect and
    // report a refusal exactly like a dead server, so an install granting only
    // lianki.com called every host on earth dead — a live YouTube watch page
    // included. @connect is frozen at install time, so no bundle fix could reach
    // it. lianki.com is the one origin every install can already talk to.
    let path = "";
    const probe = makeProbe(async (p) => {
      path = p;
      return { reachable: true, status: 200 };
    });
    await probe("https://www.youtube.com/watch?v=x");
    expect(path).toContain("/api/fsrs/probe?url=");
    expect(path).toContain(encodeURIComponent("https://www.youtube.com/watch?v=x"));
  });

  it("reports a dead host as unreachable", async () => {
    const probe = makeProbe(async () => ({ reachable: false, reason: "tls" }));
    expect((await probe("https://brainstorm.snomiao.dev/faq")).ok).toBe(false);
  });

  it("treats any answer as reachable, whatever the status", async () => {
    for (const status of [200, 403, 404, 500]) {
      const probe = makeProbe(async () => ({ reachable: true, status, reason: "ok" }));
      expect((await probe("https://example.test/x")).ok).toBe(true);
    }
  });

  it("surfaces the post-redirect url", async () => {
    const probe = makeProbe(async () => ({
      reachable: true,
      status: 200,
      finalUrl: "https://snomiao.com/ja",
    }));
    expect((await probe("https://snomiao.com/")).finalUrl).toBe("https://snomiao.com/ja");
  });

  it("never skips a card when the probe itself could not run", async () => {
    // Offline, signed out, rate limited, endpoint not deployed. None of these
    // say anything about the card's host, and a wrong "dead" verdict silently
    // drops a card the user wanted.
    for (const err of [new Error("Network error"), new Error("Login required")]) {
      const probe = makeProbe(async () => {
        throw err;
      });
      expect((await probe("https://example.test/x")).ok).toBe(true);
    }
  });

  it("bounds how long it can hold up navigation", async () => {
    // GM_xmlhttpRequest has no AbortSignal, so the timeout goes through as an
    // option; without it a hanging probe strands the user on the reviewed page.
    let opts: { timeout?: number } = {};
    const probe = makeProbe(async (_p, o) => {
      opts = (o ?? {}) as { timeout?: number };
      return { reachable: true };
    });
    await probe("https://example.test/x", 1234);
    expect(opts.timeout).toBe(1234);
  });
});
