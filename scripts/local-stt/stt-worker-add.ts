#!/usr/bin/env bun
/**
 * Add one of Lianki's speech servers to the registry's list (D1 stt_worker;
 * docs/local-stt.md, "Lianki's speech servers for everyone"). Only after the
 * owner's approval (a tap card): a worker on this list may serve other
 * accounts' audio. Revoking is on /dev/stt-access.
 *
 *   ~/.cache/lianki-stt/stt-peer keygen            # prints the public key (the private one stays, 0600)
 *   bun scripts/local-stt/stt-worker-add.ts --id mac --name "Owner's Mac" --key <public key> [--capacity 3] [--local]
 *       [--owner <account id>]   # one account's own speech server: the registry sends it that
 *                                # account first, and server.py treats those sessions as his
 *                                # (--owner also writes ~/.config/lianki-stt/peer-owner, 0600)
 *
 * Production by default (this Mac's `bunx wrangler login` authorises it); --local
 * for the local D1. Audited with the actor `cli`. The public key only: nothing
 * secret goes through here.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { WORKER_ID_RE, WORKER_KEY_RE } from "../../lib/stt-worker/store";

const PEER_OWNER_FILE = join(homedir(), ".config/lianki-stt/peer-owner");

export type WorkerArgs = {
  id: string;
  name: string;
  key: string;
  capacity: number | null;
  local: boolean;
  /** The account it belongs to (stt_worker.owner_user_id), or null: a shared one. */
  owner: string | null;
};

/** An account id as D1 keeps it (never an email). */
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

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
  const owner = get("owner") ?? null;
  if (owner !== null && !ACCOUNT_ID_RE.test(owner))
    throw new Error("--owner: an account id (letters, digits, _ -), never an email");
  return { id, name, key, capacity, local: argv.includes("--local"), owner };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The insert and its audit row, as one statement list (every value checked above). */
export function workerAddSql(a: WorkerArgs, now: number): string {
  return [
    `INSERT INTO stt_worker (id, pubkey, name, owner_user_id, capacity, created_by, created_at)
     VALUES (${q(a.id)}, ${q(a.key)}, ${q(a.name)}, ${a.owner ? q(a.owner) : "NULL"}, ${a.capacity ?? "NULL"}, 'cli', ${now})`,
    `INSERT INTO security_audit (at_ms, kind, actor, subject, detail)
     VALUES (${now}, 'stt-worker.add', 'cli', ${q(a.id)}, NULL)`,
  ].join(";\n");
}

/** server.py's --peer-owner-file: that account's sessions on this Mac are the owner's. */
export function writeOwner(owner: string, path = PEER_OWNER_FILE): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${owner}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
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
    if (a.owner) writeOwner(a.owner);
    out.log(`added speech server ${a.id}${a.owner ? " (one account's own)" : ""}`);
    return 0;
  } catch (e) {
    out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
