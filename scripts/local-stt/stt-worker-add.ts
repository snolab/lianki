#!/usr/bin/env bun
/**
 * Add one of Lianki's speech servers to the registry's list (D1 stt_worker;
 * docs/local-stt.md, "Lianki's speech servers for everyone"). Only after the
 * owner's approval (a tap card): a worker on this list may serve other
 * accounts' audio. Revoking is on /dev/stt-access.
 *
 *   ~/.cache/lianki-stt/stt-peer keygen            # prints the public key (the private one stays, 0600)
 *   bun scripts/local-stt/stt-worker-add.ts --id mac --name "Owner's Mac" --key <public key> [--capacity 3] [--local]
 *
 * Production by default (this Mac's `bunx wrangler login` authorises it); --local
 * for the local D1. Audited with the actor `cli`. The public key only: nothing
 * secret goes through here.
 */
import { WORKER_ID_RE, WORKER_KEY_RE } from "../../lib/stt-worker/store";

export type WorkerArgs = {
  id: string;
  name: string;
  key: string;
  capacity: number | null;
  local: boolean;
};

export function parseWorkerArgs(argv: string[]): WorkerArgs {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const id = get("id") ?? "";
  const key = get("key") ?? "";
  const name = (get("name") ?? id).trim();
  const cap = get("capacity");
  if (!WORKER_ID_RE.test(id)) throw new Error("--id: a short lower-case slug (a-z, 0-9, -)");
  if (!WORKER_KEY_RE.test(key))
    throw new Error("--key: the raw Ed25519 public key, base64url (43 characters)");
  if (!/^[\p{L}\p{N} '’.-]{1,80}$/u.test(name))
    throw new Error("--name: letters, digits, spaces, ' . - (≤ 80)");
  const capacity = cap === undefined ? null : Number(cap);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 32))
    throw new Error("--capacity: 0–32");
  return { id, name, key, capacity, local: argv.includes("--local") };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The insert and its audit row, as one statement list (every value checked above). */
export function workerAddSql(a: WorkerArgs, now: number): string {
  return [
    `INSERT INTO stt_worker (id, pubkey, name, owner_user_id, capacity, created_by, created_at)
     VALUES (${q(a.id)}, ${q(a.key)}, ${q(a.name)}, NULL, ${a.capacity ?? "NULL"}, 'cli', ${now})`,
    `INSERT INTO security_audit (at_ms, kind, actor, subject, detail)
     VALUES (${now}, 'stt-worker.add', 'cli', ${q(a.id)}, NULL)`,
  ].join(";\n");
}

/** Run it: wrangler d1 with the statements; 0 on success, 1 with the reason on stderr. */
export function main(
  argv: string[],
  run: (
    cmd: string[],
    o: { stdout: "inherit"; stderr: "inherit" },
  ) => {
    exitCode: number | null;
  } = Bun.spawnSync,
  now = Date.now(),
  out: Pick<Console, "log" | "error"> = console,
): number {
  try {
    const a = parseWorkerArgs(argv);
    const target = a.local ? "--local" : "--remote";
    const r = run(
      ["bunx", "wrangler", "d1", "execute", "lianki", target, "--command", workerAddSql(a, now)],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (r.exitCode !== 0) throw new Error(`wrangler exited ${r.exitCode}`);
    out.log(`added speech server ${a.id}`);
    return 0;
  } catch (e) {
    out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
