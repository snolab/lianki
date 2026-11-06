/**
 * Starts the two local Workers on one throwaway D1, for compare-local.ts and
 * measure-local.ts. Nothing here can reach Cloudflare: both configs name a D1 id
 * that does not exist there, wrangler runs `--local`, and the main Worker's
 * config below drops its tail consumer, its PUSH binding and its cron.
 *
 * Needs a finished OpenNext build at the repo root (.open-next/worker.js).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const EDGE_DIR = resolve(import.meta.dirname, "..");
export const ROOT = resolve(EDGE_DIR, "../..");
const D1_NAME = "lianki-edge-local";

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });
}

const children: ChildProcess[] = [];
export function stopAll() {
  for (const child of children.splice(0)) {
    try {
      process.kill(-(child.pid as number), "SIGTERM");
    } catch {}
  }
}
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

/** Its own process group, so wrangler's or Vite's workerd stops with it. */
export function start(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "ignore", process.env.SPIKE_VERBOSE ? "inherit" : "ignore"],
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}

export const stop = (child: ChildProcess) => {
  children.splice(children.indexOf(child), 1);
  try {
    process.kill(-(child.pid as number), "SIGTERM");
  } catch {}
};

/** Resolves once the origin answers anything at all; returns ms since `from`. */
export async function ready(origin: string, path = "/api/preferences", from = performance.now()) {
  const deadline = from + 240_000;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(origin + path, {
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      await res.arrayBuffer();
      if (res.status < 500) return performance.now() - from;
    } catch {}
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${origin} did not answer in time`);
}

export type Stage = {
  dir: string;
  mainConfig: string;
  env: Record<string, string>;
  devVars: (baseUrl: string) => void;
  sql: (command: string) => string;
  cleanup: () => void;
};

/** A temp dir with the main Worker's local config, migrated local D1, and a private dev registry. */
export function stage(): Stage {
  if (!existsSync(join(ROOT, ".open-next/worker.js"))) {
    throw new Error("no OpenNext build: CF_BUILD=1 DB_BACKEND=d1 bunx opennextjs-cloudflare build");
  }
  const dir = mkdtempSync(join(tmpdir(), "lianki-edge-"));
  const mainConfig = join(dir, "main.jsonc");
  const persist = join(dir, "state");
  writeFileSync(
    mainConfig,
    JSON.stringify({
      name: "lianki",
      main: join(ROOT, "worker.ts"),
      compatibility_date: "2025-05-05",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: join(ROOT, ".open-next/assets"), binding: "ASSETS" },
      vars: { DB_BACKEND: "d1" },
      d1_databases: [
        {
          binding: "DB",
          database_name: D1_NAME,
          database_id: D1_NAME,
          migrations_dir: join(ROOT, "db/migrations"),
        },
      ],
      r2_buckets: [{ binding: "BLOBS", bucket_name: "lianki-edge-local" }],
    }),
  );
  const devVars = (baseUrl: string) => {
    const text = [
      "NODE_ENV=development",
      "DB_BACKEND=d1",
      "DEV_EMAIL_PASSWORD_AUTH=1",
      "AUTH_SECRET=dev-qa-secret-not-for-production",
      `BETTER_AUTH_BASE_URL=${baseUrl}`,
      "",
    ].join("\n");
    writeFileSync(join(dir, ".dev.vars"), text);
    writeFileSync(join(EDGE_DIR, ".dev.vars"), text);
  };
  const wrangler = (args: string[]) => {
    const r = spawnSync(
      "bunx",
      ["wrangler", ...args, "--local", "--persist-to", persist, "-c", mainConfig],
      {
        cwd: ROOT,
        encoding: "utf8",
      },
    );
    if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")}: ${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  wrangler(["d1", "migrations", "apply", D1_NAME]);
  return {
    dir,
    mainConfig,
    devVars,
    // Without a private registry MAIN binds to any `lianki` that any checkout on
    // this machine has running (qa:all elsewhere). Wrangler and miniflare each
    // read their own variable.
    env: {
      WRANGLER_REGISTRY_PATH: join(dir, "registry"),
      MINIFLARE_REGISTRY_PATH: join(dir, "registry"),
      EDGE_PERSIST: persist,
    },
    sql: (command) => wrangler(["d1", "execute", D1_NAME, "--command", command]),
    cleanup: () => {
      stopAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const startMain = (s: Stage, port: number) =>
  start(
    "bunx",
    [
      "wrangler",
      "dev",
      "--local",
      "--port",
      String(port),
      "--persist-to",
      s.env.EDGE_PERSIST,
      "-c",
      s.mainConfig,
    ],
    ROOT,
    s.env,
  );

/** `vite dev`, or `vite preview` of the production build in dist/. */
export const startEdge = (s: Stage, port: number, mode: "dev" | "preview") =>
  start(
    "bun",
    [
      "--bun",
      "node_modules/.bin/vite",
      ...(mode === "dev" ? [] : ["preview"]),
      "--port",
      `${port}`,
    ],
    EDGE_DIR,
    s.env,
  );
