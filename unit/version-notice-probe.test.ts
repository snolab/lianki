import { expect, test } from "bun:test";
import { probeVersion, VERSION_PROBE_TIMEOUT_MS } from "../lib/version-probe";

const TARGET = "announced-build";
const fingerprints = (build = TARGET) => ({
  build,
  shell: "shell-hash",
  routes: { "/words": "route-hash" },
});
const response = (build = TARGET) => Response.json(fingerprints(build));
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const delays: number[] = [];
  return {
    delays,
    pending,
    later(callback: () => void, delay: number) {
      const key = ++id;
      delays.push(delay);
      pending.set(key, { at: now + delay, callback });
      return () => {
        pending.delete(key);
      };
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        await flush();
        const next = [...pending]
          .filter(([, item]) => item.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].callback();
      }
      now = until;
      await flush();
    },
  };
}
function callbacks() {
  const events: string[] = [];
  return {
    events,
    ready: () => {
      events.push("ready");
    },
    unavailable: () => {
      events.push("unavailable");
    },
  };
}

test("immediate no-cache same-origin request accepts only the announced build, including after a newer mismatch", async () => {
  const clock = fakeClock();
  const cb = callbacks();
  const calls: { url: string; init: RequestInit }[] = [];
  const builds = ["page-current-old-build", "another-newer-build", TARGET];
  const cancel = probeVersion({
    build: TARGET,
    ...cb,
    later: clock.later,
    fetcher: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return response(builds[calls.length - 1]);
    }) as unknown as typeof fetch,
  });
  expect(calls).toHaveLength(1);
  await flush();
  expect(cb.events).toEqual([]);
  await clock.advance(100);
  expect(cb.events).toEqual([]);
  await clock.advance(200);
  expect(cb.events).toEqual(["ready"]);
  expect(calls).toHaveLength(3);
  for (const { url, init } of calls) {
    const parsed = new URL(url, "https://fixture.invalid");
    expect(parsed.pathname).toBe("/_lk/route-fp.json");
    expect(parsed.searchParams.get("_lk_probe")).toBeTruthy();
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    expect(init.method ?? "GET").toBe("GET");
    expect(init.signal?.aborted).toBe(true);
  }
  expect(new Set(calls.map((c) => c.url)).size).toBe(3);
  expect(clock.pending.size).toBe(0);
  await clock.advance(10000);
  cancel();
  expect(calls).toHaveLength(3);
  expect(cb.events).toEqual(["ready"]);
});

for (const mode of ["http", "invalid-json", "invalid-fingerprints", "network"] as const) {
  test(`${mode} retries without declaring readiness, then accepts a valid response`, async () => {
    const clock = fakeClock();
    const cb = callbacks();
    let calls = 0;
    let bodyReads = 0;
    probeVersion({
      build: TARGET,
      ...cb,
      later: clock.later,
      fetcher: (async () => {
        if (++calls > 1) return response();
        if (mode === "network") throw Error("offline fixture");
        if (mode === "invalid-json") return new Response("not JSON");
        if (mode === "invalid-fingerprints") return Response.json({ build: TARGET });
        const refused = new Response("not read", { status: 503 });
        refused.json = async () => {
          bodyReads++;
          throw Error("must not read rejected body");
        };
        return refused;
      }) as unknown as typeof fetch,
    });
    await flush();
    expect(cb.events).toEqual([]);
    await clock.advance(99);
    expect(calls).toBe(1);
    await clock.advance(1);
    expect(calls).toBe(2);
    expect(cb.events).toEqual(["ready"]);
    expect(bodyReads).toBe(0);
    expect(clock.pending.size).toBe(0);
  });
}

test("backoff is sequential, caps at 800ms and stops at the independent 2500ms deadline", async () => {
  const clock = fakeClock();
  const cb = callbacks();
  let calls = 0;
  probeVersion({
    build: TARGET,
    ...cb,
    later: clock.later,
    fetcher: (async () => {
      calls++;
      return response("old");
    }) as unknown as typeof fetch,
  });
  await clock.advance(2499);
  expect(calls).toBe(6); // t=0,100,300,700,1500,2300
  expect(clock.delays).toEqual([VERSION_PROBE_TIMEOUT_MS, 100, 200, 400, 800, 800, 800]);
  expect(cb.events).toEqual([]);
  await clock.advance(1);
  expect(cb.events).toEqual(["unavailable"]);
  expect(clock.pending.size).toBe(0);
  await clock.advance(10000);
  expect(calls).toBe(6);
  expect(cb.events).toEqual(["unavailable"]);
});

test("a slow fetch never overlaps another request; deadline aborts and late success cannot reload", async () => {
  const clock = fakeClock();
  const cb = callbacks();
  const requests: { result: ReturnType<typeof deferred<Response>>; signal: AbortSignal }[] = [];
  probeVersion({
    build: TARGET,
    ...cb,
    later: clock.later,
    fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => {
      const result = deferred<Response>();
      requests.push({ result, signal: init!.signal! });
      return result.promise;
    }) as unknown as typeof fetch,
  });
  await clock.advance(1000);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(false);
  requests[0]!.result.resolve(response("old"));
  await flush();
  await clock.advance(99);
  expect(requests).toHaveLength(1);
  await clock.advance(1);
  expect(requests).toHaveLength(2);
  await clock.advance(1399);
  expect(cb.events).toEqual([]);
  await clock.advance(1);
  expect(cb.events).toEqual(["unavailable"]);
  expect(requests.every((r) => r.signal.aborted)).toBe(true);
  requests[1]!.result.resolve(response());
  await flush();
  expect(cb.events).toEqual(["unavailable"]);
  expect(clock.pending.size).toBe(0);
});

for (const ending of ["deadline", "cancel"] as const) {
  test(`${ending} during JSON body reading aborts, ignores late matching JSON and leaves no timers`, async () => {
    const clock = fakeClock();
    const cb = callbacks();
    const body = deferred<unknown>();
    let signal!: AbortSignal;
    let calls = 0;
    const cancel = probeVersion({
      build: TARGET,
      ...cb,
      later: clock.later,
      fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        signal = init!.signal!;
        const result = response();
        result.json = () => body.promise;
        return result;
      }) as unknown as typeof fetch,
    });
    await clock.advance(1000);
    expect(calls).toBe(1);
    expect(signal.aborted).toBe(false);
    if (ending === "cancel") cancel();
    else await clock.advance(1500);
    expect(signal.aborted).toBe(true);
    expect(cb.events).toEqual(ending === "cancel" ? [] : ["unavailable"]);
    body.resolve(fingerprints());
    await flush();
    await clock.advance(10000);
    expect(calls).toBe(1);
    expect(cb.events).toEqual(ending === "cancel" ? [] : ["unavailable"]);
    expect(clock.pending.size).toBe(0);
  });
}

test("cancel during fetch ignores a late matching response without even reading its body", async () => {
  const clock = fakeClock();
  const cb = callbacks();
  const pending = deferred<Response>();
  let signal!: AbortSignal;
  let reads = 0;
  const cancel = probeVersion({
    build: TARGET,
    ...cb,
    later: clock.later,
    fetcher: ((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init!.signal!;
      return pending.promise;
    }) as unknown as typeof fetch,
  });
  cancel();
  cancel();
  const late = response();
  late.json = async () => {
    reads++;
    return fingerprints();
  };
  pending.resolve(late);
  await clock.advance(10000);
  expect(signal.aborted).toBe(true);
  expect(reads).toBe(0);
  expect(cb.events).toEqual([]);
  expect(clock.pending.size).toBe(0);
});

test("unmount cancels an already scheduled retry and manual fallback", async () => {
  const clock = fakeClock();
  const cb = callbacks();
  let calls = 0;
  const cancel = probeVersion({
    build: TARGET,
    ...cb,
    later: clock.later,
    fetcher: (async () => {
      calls++;
      return response("old");
    }) as unknown as typeof fetch,
  });
  await flush();
  expect(clock.pending.size).toBe(2);
  cancel();
  await clock.advance(10000);
  expect(calls).toBe(1);
  expect(cb.events).toEqual([]);
  expect(clock.pending.size).toBe(0);
});

test("default global fetch and real timer retry can reach ready without network access", async () => {
  const original = globalThis.fetch;
  let cancel = () => {};
  let calls = 0;
  const events: string[] = [];
  globalThis.fetch = (async () =>
    response(++calls === 1 ? "old" : TARGET)) as unknown as typeof fetch;
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = probeVersion({
        build: TARGET,
        ready: () => {
          events.push("ready");
          resolve();
        },
        unavailable: () => reject(Error("unexpected deadline")),
      });
    });
    expect(calls).toBe(2);
    expect(events).toEqual(["ready"]);
  } finally {
    cancel();
    globalThis.fetch = original;
  }
}, 1000);

// A timer can already be queued when clearTimeout/cancel runs. Its stale
// callback must not override a successful probe, unmount, or earlier fallback.
for (const outcome of ["ready", "cancel", "unavailable"] as const) {
  test(`queued deadline after ${outcome} never repeats or changes the outcome`, async () => {
    const clock = fakeClock();
    const cb = callbacks();
    const pending = deferred<Response>();
    const cancel = probeVersion({
      build: TARGET,
      ...cb,
      later: clock.later,
      fetcher: (() => pending.promise) as unknown as typeof fetch,
    });
    const queuedDeadline = [...clock.pending.values()].find(
      (timer) => timer.at === VERSION_PROBE_TIMEOUT_MS,
    )!.callback;
    if (outcome === "ready") {
      pending.resolve(response());
      await flush();
    } else if (outcome === "cancel") cancel();
    else await clock.advance(VERSION_PROBE_TIMEOUT_MS);
    queuedDeadline();
    queuedDeadline();
    pending.resolve(response());
    await flush();
    await clock.advance(10000);
    cancel();
    expect(cb.events).toEqual(outcome === "cancel" ? [] : [outcome]);
    expect(clock.pending.size).toBe(0);
  });
}

for (const phase of ["fetch", "json"] as const) {
  test(`elapsed deadline wins over late ${phase} success before the browser timer runs`, async () => {
    const clock = fakeClock();
    const cb = callbacks();
    const pendingFetch = deferred<Response>();
    const pendingJson = deferred<unknown>();
    let elapsed = 0;
    let calls = 0;
    let signal!: AbortSignal;
    const cancel = probeVersion({
      build: TARGET,
      ...cb,
      now: () => elapsed,
      later: clock.later,
      fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        signal = init!.signal!;
        if (phase === "fetch") return pendingFetch.promise;
        const result = response();
        result.json = () => pendingJson.promise;
        return result;
      }) as unknown as typeof fetch,
    });
    await flush();
    // Browser timers are throttled: wall time advances without firing the deadline task.
    elapsed = VERSION_PROBE_TIMEOUT_MS + 1;
    if (phase === "fetch") pendingFetch.resolve(response());
    else pendingJson.resolve(fingerprints());
    await flush();
    expect(cb.events).toEqual(["unavailable"]);
    expect(signal.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(clock.pending.size).toBe(0);
    await clock.advance(10000);
    cancel();
    expect(cb.events).toEqual(["unavailable"]);
  });
}

test("a throttled retry callback after the elapsed deadline never starts another fetch", async () => {
  const clock = fakeClock();
  const cb = callbacks();
  let elapsed = 0;
  let calls = 0;
  probeVersion({
    build: TARGET,
    ...cb,
    now: () => elapsed,
    later: clock.later,
    fetcher: (async () => {
      calls++;
      return response("old");
    }) as unknown as typeof fetch,
  });
  await flush();
  const queuedRetry = [...clock.pending.values()].find((timer) => timer.at === 100)!.callback;
  elapsed = VERSION_PROBE_TIMEOUT_MS + 1;
  queuedRetry();
  await flush();
  expect(calls).toBe(1);
  expect(cb.events).toEqual(["unavailable"]);
  expect(clock.pending.size).toBe(0);
  queuedRetry();
  await clock.advance(10000);
  expect(calls).toBe(1);
  expect(cb.events).toEqual(["unavailable"]);
});
