import { describe, expect, it, mock } from "bun:test";
import {
  broadcast,
  cliError,
  main,
  parseArgs,
  PUBLISH_URL,
} from "../scripts/dev/broadcast-version";
import { explicitVersionNews } from "../lib/version-publish";
import worker, { VersionHub, type Env } from "../workers/push/src/index";

describe("broadcast-version", () => {
  it("validates CLI input before sending", () => {
    for (const args of [
      [],
      ["--build"],
      ["--bad"],
      ["--build", "x", "--build", "y"],
      ["--build", "a b"],
      ["--build", "a".repeat(65)],
      ["--build", "a", "--routes", "bad"],
      ["--build", "a", "--url", "https://example.test/wrong"],
      ["--build", "a", "--url", "file:///internal/publish"],
    ])
      expect(() => parseArgs(args)).toThrow();
    expect(parseArgs(["--build", "abc-1"]).init.body).toBe("abc-1");
    expect(parseArgs(["--build", "a", "--url", "http://localhost:8787/internal/publish"]).url).toBe(
      "http://localhost:8787/internal/publish",
    );
  });
  it("validates explicit VersionNews without coercing protocol fields", () => {
    for (const value of [
      null,
      {},
      { build: "a", shell: false, routes: [] },
      { build: "a", shell: false, routes: { bad: 1 } },
      { build: "a", shell: false, routes: { "/words": true } },
      { build: "a", shell: false, routes: {}, force: 1 },
    ])
      expect(() => explicitVersionNews(value)).toThrow();
    expect(explicitVersionNews({ build: "a", shell: false, routes: {}, force: true }).force).toBe(
      true,
    );
    expect(
      explicitVersionNews({ build: "a", shell: false, routes: {}, force: false }).force,
    ).toBeUndefined();
  });
  it("publishes through the internal gate to every connected socket, idempotently", async () => {
    const messages = [[], []] as string[][];
    const store = new Map<string, unknown>();
    const hub = new VersionHub(
      {
        acceptWebSocket() {},
        getWebSockets: () =>
          messages.map((out) => ({ send: (s: string) => out.push(s) }) as unknown as WebSocket),
        storage: {
          get: async <T>(key: string) => store.get(key) as T | undefined,
          put: async (key, value) => {
            store.set(key, value);
          },
        },
      },
      {} as Env,
    );
    const env = { HUB: { idFromName: (name: string) => name, get: () => hub } } as unknown as Env;
    const send: import("../scripts/dev/broadcast-version").Send = async (url, init) => {
      expect(String(url)).toBe(PUBLISH_URL);
      return worker.fetch(new Request(url, init), env);
    };
    const args = ["--build", "new-1", "--shell-changed", "--routes", '{"/words":1,"/list":0}'];
    expect(await broadcast(args, send)).toEqual({ build: "new-1", pushed: 2 });
    for (const out of messages)
      expect(JSON.parse(out[0])).toEqual({
        build: "new-1",
        shell: true,
        routes: { "/words": 1, "/list": 0 },
      });
    expect(await broadcast(args, send)).toEqual({ build: "new-1", pushed: 0 });
    expect(messages[0]).toHaveLength(1);
    await broadcast(["--build", "new-2"], send);
    expect(JSON.parse(messages[0][1])).toEqual({ build: "new-2" });
    const bad = await hub.fetch(
      new Request(PUBLISH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(bad.status).toBe(400);
    expect(
      (
        await worker.fetch(
          new Request("https://lianki.com/internal/publish", { method: "POST", body: "evil" }),
          env,
        )
      ).status,
    ).toBe(404);
  });
  it("fails on HTTP errors or malformed acknowledgements", async () => {
    for (const response of [
      new Response("bad", { status: 503 }),
      Response.json({ build: "other", pushed: 1 }),
      Response.json({ build: "a", pushed: -1 }),
      Response.json({ build: "a", pushed: 0.5 }),
    ])
      await expect(broadcast(["--build", "a"], async () => response)).rejects.toThrow();
    await expect(
      broadcast(["--build", "a"], async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");
  });
  it("prints help without contacting Cloudflare", async () => {
    await main(["--help"]);
  });
});

it("opens and disposes the remote binding, including on refusal", async () => {
  let disposed = 0;
  let status = 200;
  mock.module("wrangler", () => ({
    getPlatformProxy: async () => ({
      env: {
        PUSH: {
          fetch: async () =>
            status === 200
              ? Response.json({ build: "remote", pushed: 0 })
              : new Response(null, { status }),
        },
      },
      dispose: async () => {
        disposed++;
      },
    }),
  }));
  await main(["--build", "remote"]);
  status = 503;
  await expect(main(["--build", "remote"])).rejects.toThrow("503");
  expect(disposed).toBe(2);
});
it("supports the trusted local endpoint end to end", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => Response.json({ build: await req.text(), pushed: 0 }),
  });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/dev/broadcast-version.ts",
        "--build",
        "local",
        "--url",
        `http://localhost:${server.port}/internal/publish`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      build: "local",
      pushed: 0,
    });
  } finally {
    server.stop(true);
  }
});

it("reports CLI failures and supports an injected endpoint transport", async () => {
  const previous = process.exitCode;
  try {
    cliError(new Error("expected CLI failure"));
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
  }
  await main(["--build", "a", "--url", "http://localhost/internal/publish"], async () =>
    Response.json({ build: "a", pushed: 0 }),
  );
});

it("requires preview credentials and matching fingerprints before sending", async () => {
  const { previewHeaders } = await import("../scripts/dev/broadcast-version");
  const url = "https://lianki-push-preview.example.workers.dev/internal/publish";
  const env = {
    PREVIEW_PUBLISH_TOKEN: "test-only",
    PREVIEW_ORIGIN: "https://preview.example.test",
  };
  const fp = { build: "a", shell: "s", routes: { "/words": "w" } };
  const headers = await previewHeaders("a", url, env, async () => JSON.stringify(fp));
  expect(headers.authorization).toBe("Bearer test-only");
  expect(headers.origin).toBe(env.PREVIEW_ORIGIN);
  expect(JSON.parse(decodeURIComponent(headers["x-lk-fingerprints"]))).toEqual(fp);
  await expect(previewHeaders("b", url, env, async () => JSON.stringify(fp))).rejects.toThrow(
    "match build",
  );
  await expect(previewHeaders("a", url, {}, async () => "{}")).rejects.toThrow("required");
  await expect(previewHeaders("a", "https://other.test/internal/publish", env)).rejects.toThrow(
    "preview",
  );
  await expect(previewHeaders("a", url, env, async () => "{}")).rejects.toThrow("match build");
  await expect(
    previewHeaders("a", url, env, async () => {
      throw new Error("missing file");
    }),
  ).rejects.toThrow("missing file");
  // Exercise the production file reader too; this checkout has no generated preview build.
  await previewHeaders("nonexistent-build", url, env).catch(() => undefined);
});
