/**
 * The network side of scripts/dev/progress.ts and progress-seed.ts: where
 * the token comes from, and one request to the hub.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** --token, else LIANKI_PROGRESS_TOKEN, else PROGRESS_TOKEN, else .dev.vars (this checkout, then the main one). */
export function progressToken(flag?: string): string | undefined {
  const env = flag || process.env.LIANKI_PROGRESS_TOKEN || process.env.PROGRESS_TOKEN;
  if (env) return env;
  const roots = [join(import.meta.dir, "..", "..")];
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dir,
  });
  if (git.success) roots.push(dirname(git.stdout.toString().trim()));
  for (const root of roots) {
    try {
      const m = /^PROGRESS_TOKEN=["']?([^"'\n]+)["']?\s*$/m.exec(
        readFileSync(join(root, ".dev.vars"), "utf8"),
      );
      if (m) return m[1]!.trim();
    } catch {}
  }
}

/** POST `body` (or GET without one) to `<base>/api/version/progress<path>`; the JSON answer, or an Error. */
export async function postProgress(
  base: string,
  token: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown> | Error> {
  try {
    const res = await fetch(`${base}/api/version/progress${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) return new Error(`${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}
