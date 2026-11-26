/**
 * `--eta auto` end to end (.agents/skills/estimate): the real entrypoints,
 * progress.ts and `lianki-dev progress`, spawned against a stub hub with a
 * fake done history and a temporary estimate log. The report the hub gets
 * carries the estimator's P5-P95, and the log keeps that estimate by node.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { etaRange } from "@/lib/estimate";
import { parseEta } from "@/lib/progress";

const M = 60_000;
const NOW = Date.now();
/** 30 done tasks like the one asked about, each 20 minutes. */
const HISTORY = Array.from({ length: 30 }, (_, i) => ({
  id: `/dev/gantt/label-${i}`,
  title: "Gantt label: fix the overlap",
  agent: "claude",
  kind: "task",
  created: NOW - (i + 2) * 60 * M,
  startedAt: NOW - (i + 2) * 60 * M,
  endedAt: NOW - (i + 2) * 60 * M + 20 * M,
  estimateMs: 20 * M,
}));

describe("--eta auto through the real CLIs", () => {
  const dir = mkdtempSync(join(tmpdir(), "estimate-cli-"));
  const posted: Record<string, unknown>[] = [];
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === "GET" && path === "/api/version/progress/history")
          return Response.json({ items: HISTORY });
        if (req.method === "POST" && path === "/api/version/progress") {
          const body = (await req.json()) as Record<string, unknown>;
          posted.push(body);
          return Response.json({ entry: { id: body.id, status: "doing", rev: 1 }, readers: 0 });
        }
        return new Response("stub", { status: 404 });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (script: string, args: string[], log: string) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      LIANKI_URL: `http://127.0.0.1:${server.port}`,
      LIANKI_PROGRESS_TOKEN: "stub-token",
      LIANKI_ESTIMATES_LOG: log,
      LIANKI_TOKEN: undefined,
      LIANKI_LANE: undefined,
      LIANKI_LANE_TOKEN_DIR: join(dir, "no-lanes"),
    };
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "..", "scripts", "dev", script), ...args],
      { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  const check = (log: string, node: string) => {
    const body = posted.at(-1)!;
    expect(body.id).toBe(node);
    const eta = String(body.eta);
    const r = parseEta(eta);
    expect(r && "in" in r && r.min !== undefined).toBe(true);
    // ~20 minutes, never the free text "auto"
    expect((r as { in: number }).in).toBeGreaterThan(20 * M);
    expect((r as { min: number }).min).toBeLessThan(20 * M);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const e = JSON.parse(lines.at(-1)!) as {
      type: string;
      node: string;
      kind: string;
      p5: number;
      p95: number;
    };
    expect(e).toMatchObject({ type: "estimate", node, kind: "ui-fix" });
    expect(etaRange(e)).toBe(eta);
  };

  it("progress.ts posts the estimator's P5-P95 and logs it by node", async () => {
    const log = join(dir, "a.jsonl");
    const node = "/dev/gantt/new-label";
    const r = await run(
      "progress.ts",
      [
        "--agent",
        "claude",
        "--path",
        node,
        "--task",
        "Gantt label: fix the bar",
        "--status",
        "doing",
        "--eta",
        "auto:ui-fix",
      ],
      log,
    );
    expect(r.stderr).toContain("--eta auto → ");
    expect(r.exitCode).toBe(0);
    check(log, node);
  }, 30_000);

  it("lianki-dev progress does the same", async () => {
    const log = join(dir, "b.jsonl");
    const node = "/dev/gantt/other-label";
    const r = await run(
      "lianki-dev.ts",
      [
        "progress",
        "--agent",
        "claude",
        "--path",
        node,
        "--task",
        "Gantt label: fix the bar",
        "--status",
        "doing",
        "--eta=auto:ui-fix",
      ],
      log,
    );
    expect(r.stderr).toContain("--eta auto → ");
    expect(r.exitCode).toBe(0);
    check(log, node);
  }, 30_000);

  it("a bad kind is a usage error, nothing posted", async () => {
    const before = posted.length;
    const r = await run(
      "progress.ts",
      [
        "--agent",
        "claude",
        "--path",
        "/x/y",
        "--task",
        "X: y",
        "--status",
        "doing",
        "--eta",
        "auto:nonsense",
      ],
      join(dir, "c.jsonl"),
    );
    expect(r.exitCode).toBe(2);
    expect(posted.length).toBe(before);
  }, 30_000);
});
