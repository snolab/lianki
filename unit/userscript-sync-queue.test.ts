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
  /** End offset of the function whose declaration starts at `start`. */
  function bodyEnd(start: number) {
    const open = BUILT.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < BUILT.length; i++) {
      if (BUILT[i] === "{") depth++;
      else if (BUILT[i] === "}" && --depth === 0) return i + 1;
    }
    throw new Error("unterminated function in the built userscript");
  }

  function sliceFn(name: string, decl = `function ${name}(`) {
    const start = BUILT.indexOf(decl);
    if (start === -1) throw new Error(`${name} not found in the built userscript`);
    return BUILT.slice(start, bodyEnd(start));
  }

  /** Lift the bare transport and drive it with a fake GM_xmlhttpRequest. */
  function makeProbe(impl: (opts: Record<string, unknown>) => void) {
    const src = `${sliceFn("isConnectRefusal")}\n${sliceFn("rawProbe")}\nreturn rawProbe;`;
    return new Function("GM_xmlhttpRequest", src)(impl) as (
      u: string,
      t?: number,
    ) => Promise<{ ok: boolean; finalUrl?: string }>;
  }

  /**
   * Lift the guarded probe — transport plus the "is the probe itself working?"
   * check — with a controllable current page.
   */
  function makeGuardedProbe(impl: (opts: Record<string, unknown>) => void) {
    const src = [
      sliceFn("isConnectRefusal"),
      sliceFn("rawProbe"),
      "let probesUsable = null;",
      sliceFn("probesAreUsable", "async function probesAreUsable("),
      sliceFn("probeUrl", "async function probeUrl("),
      "return probeUrl;",
    ].join("\n");
    return new Function("GM_xmlhttpRequest", "console", src)(impl, { warn() {} }) as (
      u: string,
      t?: number,
    ) => Promise<{ ok: boolean; blocked?: boolean }>;
  }

  it("reports a dead host as unreachable", async () => {
    // The retired site that left 75 cards stuck: connection refused, so no
    // userscript ever runs there and the card cannot be reviewed away.
    const probe = makeProbe((o) => (o.onerror as () => void)());
    expect((await probe("https://brainstorm.snomiao.dev/faq")).ok).toBe(false);
  });

  it("treats a timeout as unreachable", async () => {
    const probe = makeProbe((o) => (o.ontimeout as () => void)());
    expect((await probe("https://slow.test/")).ok).toBe(false);
  });

  it("treats ANY http status as reachable", async () => {
    // Status is not evidence of a dead page: plenty of good pages answer 403 to
    // a scripted HEAD, sit behind bot walls, or 404 while rendering content.
    // Skipping those would be worse than the bug being fixed.
    for (const status of [200, 403, 404, 500]) {
      const probe = makeProbe((o) =>
        (o.onload as (r: unknown) => void)({ status, finalUrl: o.url }),
      );
      expect((await probe("https://example.test/x")).ok).toBe(true);
    }
  });

  it("surfaces the post-redirect url", async () => {
    const probe = makeProbe((o) =>
      (o.onload as (r: unknown) => void)({ status: 200, finalUrl: "https://snomiao.com/ja" }),
    );
    expect((await probe("https://snomiao.com/")).finalUrl).toBe("https://snomiao.com/ja");
  });

  it("sends no cookies", async () => {
    // The probe fires at third-party sites before you visit them; it has no
    // business carrying your session, and some endpoints act on a bare HEAD.
    let seen: Record<string, unknown> = {};
    const probe = makeProbe((o) => {
      seen = o;
      (o.onload as (r: unknown) => void)({ status: 200 });
    });
    await probe("https://example.test/x");
    expect(seen.anonymous).toBe(true);
    expect(seen.method).toBe("HEAD");
  });

  it("does not call a page dead when the manager refuses the request", async () => {
    // The regression, verified in a real browser: with `@connect lianki.com`
    // only, Violentmonkey answered a probe of youtube.com in 3ms with
    // `Refused to connect ... not a part of the @connect list`. That reaches
    // onerror exactly like a dead server, so a live watch page was skipped.
    const probe = makeGuardedProbe((o) =>
      (o.onerror as (e: unknown) => void)({
        error:
          'Refused to connect to "https://www.youtube.com/": This domain is not a part of the @connect list',
      }),
    );
    const r = await probe("https://www.youtube.com/watch?v=x");
    expect(r.ok).toBe(true);
    expect(r.blocked).toBe(true);
  });

  it("does not use the current page as the control, which can never fail", async () => {
    // Measured in the browser: from news.ycombinator.com, a probe of the page's
    // own origin returned 405 — the manager always allows the origin the script
    // runs on — while every third-party host was refused. Controlling against
    // it would have proved the probe worked when it did not.
    const seen: string[] = [];
    const probe = makeGuardedProbe((o) => {
      seen.push(String(o.url));
      (o.onerror as (e: unknown) => void)({});
    });
    await probe("https://dead.test/page");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toContain("dead.test");
    expect(new URL(seen[1]).host).not.toBe("dead.test");
  });

  it("suppresses the verdict when even the control host cannot be reached", async () => {
    let calls = 0;
    const probe = makeGuardedProbe((o) => {
      calls++;
      (o.onerror as (e: unknown) => void)({});
    });
    expect((await probe("https://a.test/")).ok).toBe(true);
    expect(calls).toBe(2); // the url, then the control

    // Cached: one control probe per session, not one per card.
    expect((await probe("https://b.test/")).ok).toBe(true);
    expect(calls).toBe(3);
  });

  it("still reports a dead host when the control proves probes work", async () => {
    const probe = makeGuardedProbe((o) =>
      String(o.url).includes("brainstorm")
        ? (o.onerror as (e: unknown) => void)({})
        : (o.onload as (r: unknown) => void)({ status: 204, finalUrl: o.url }),
    );
    expect((await probe("https://brainstorm.snomiao.dev/faq")).ok).toBe(false);
  });

  it("grants itself cross-origin access, or every probe is refused", async () => {
    expect(BUILT).toMatch(/^\/\/ @connect\s+\*$/m);
  });

  it("never blocks navigation when the probe itself throws", async () => {
    const probe = makeProbe(() => {
      throw new Error("GM_xmlhttpRequest exploded");
    });
    expect((await probe("https://example.test/x")).ok).toBe(true);
  });
});
