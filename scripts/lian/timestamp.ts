#!/usr/bin/env bun
// Timestamp a day of the study ledger with OpenTimestamps (docs/lian.md,
// "Publishing"). Owner-triggered at milestones — never on a timer.
//
//   bun scripts/lian/timestamp.ts 2026-11-07            # dry run: shows the chain hash
//   bun scripts/lian/timestamp.ts 2026-11-07 --go       # submit to the calendars
//   bun scripts/lian/timestamp.ts upgrade 2026-11-07    # later: fetch the Bitcoin path
//
// Reads the anchor from D1 and keeps the .ots receipt in R2 `lianki-blobs`
// (lian/ots/<day>.ots) plus a lian_timestamp row, all through wrangler
// (`--remote`), so it needs wrangler logged in. `--go` is the only thing that
// contacts the public calendars; without it nothing leaves this machine.
// Check a receipt with the reference client:
//   ots verify -d <chainHash> <day>.ots

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDay, isHash } from "@lianki/lian";
import { type StampDeps, type StampRow, stampDay, upgradeDay } from "@/lib/lian/timestamp";

const args = process.argv.slice(2);
const isUpgrade = args[0] === "upgrade";
const day = isUpgrade ? args[1] : args[0];
const go = args.includes("--go");
if (!isDay(day)) {
  console.error("usage: bun scripts/lian/timestamp.ts [upgrade] <YYYY-MM-DD> [--go]");
  process.exit(2);
}

function wrangler(argv: string[]): string {
  const p = Bun.spawnSync(["bunx", "wrangler", ...argv], { stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`wrangler ${argv.slice(0, 3).join(" ")} failed`);
  return p.stdout.toString();
}

/** One SQL statement against remote D1. Values are validated before they get here. */
function sql<T>(command: string): T[] {
  const out = JSON.parse(
    wrangler(["d1", "execute", "lianki", "--remote", "--json", "--command", command]),
  );
  return (out[0]?.results ?? []) as T[];
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const dir = mkdtempSync(join(tmpdir(), "lianki-ots-"));
const deps: StampDeps = {
  async readChainHash(d) {
    const [r] = sql<{ chain_hash: string }>(
      `SELECT chain_hash FROM lian_anchor WHERE day = ${q(d)}`,
    );
    return r && isHash(r.chain_hash) ? r.chain_hash : null;
  },
  async readStamp(d) {
    const [r] = sql<Record<string, unknown>>(`SELECT * FROM lian_timestamp WHERE day = ${q(d)}`);
    if (!r) return null;
    return {
      day: String(r.day),
      chainHash: String(r.chain_hash),
      r2Key: String(r.r2_key),
      calendars: JSON.parse(String(r.calendars)),
      status: r.status as StampRow["status"],
      btcHeight: r.btc_height == null ? null : Number(r.btc_height),
      createdAt: String(r.created_at),
      upgradedAt: r.upgraded_at == null ? null : String(r.upgraded_at),
    };
  },
  async saveStamp(r, isNew) {
    const height = r.btcHeight == null ? "NULL" : String(Math.floor(r.btcHeight));
    sql(
      isNew
        ? `INSERT INTO lian_timestamp (day, chain_hash, r2_key, calendars, status, btc_height, created_at)
           VALUES (${q(r.day)}, ${q(r.chainHash)}, ${q(r.r2Key)}, ${q(JSON.stringify(r.calendars))}, ${q(r.status)}, ${height}, ${q(r.createdAt)})`
        : `UPDATE lian_timestamp SET status = ${q(r.status)}, btc_height = ${height}, upgraded_at = ${q(r.upgradedAt ?? "")}
           WHERE day = ${q(r.day)}`,
    );
  },
  async putReceipt(key, ots) {
    const file = join(dir, "put.ots");
    writeFileSync(file, ots);
    wrangler(["r2", "object", "put", `lianki-blobs/${key}`, "--file", file, "--remote"]);
    writeFileSync(`${day}.ots`, ots); // a local copy, for `ots verify`
  },
  async getReceipt(key) {
    const file = join(dir, "get.ots");
    wrangler(["r2", "object", "get", `lianki-blobs/${key}`, "--file", file, "--remote"]);
    return new Uint8Array(readFileSync(file));
  },
  fetch: (url, init) => {
    if (!go) throw new Error("dry run: add --go to contact the OpenTimestamps calendars");
    return fetch(url, init);
  },
};

try {
  if (!go) {
    const h = await deps.readChainHash(day);
    console.log(
      h ? `${day} chain hash ${h}\n(dry run — add --go to submit)` : `${day}: not anchored`,
    );
  } else if (isUpgrade) {
    const { row, changed } = await upgradeDay(day, deps);
    console.log(
      changed
        ? `${day}: in Bitcoin block ${row.btcHeight}`
        : `${day}: ${row.status}${row.btcHeight ? ` (block ${row.btcHeight})` : " — not in a block yet; try again in a few hours"}`,
    );
  } else {
    const { row, already, failed } = await stampDay(day, deps);
    console.log(
      already
        ? `${day}: already stamped (${row.status})`
        : `${day}: stamped ${row.chainHash} at ${row.calendars.length} calendars → ${row.r2Key}` +
            (failed.length ? `; no answer from ${failed.join(", ")}` : ""),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
