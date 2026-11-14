#!/usr/bin/env bun
/**
 * Pull a day of your mic recordings to this Mac (docs/recordings.md, "On the
 * Mac"), for processing offline:
 *
 *   bun scripts/dev/recordings-pull.ts --day 2026-11-14
 *   bun scripts/dev/recordings-pull.ts --day 2026-11-14 --stt            # and re-transcribe locally
 *   bun scripts/dev/recordings-pull.ts --day 2026-11-14 --stt ws://127.0.0.1:5193
 *
 * Writes ~/lianki-recordings/<day>/: transcript.json, transcript.txt and one
 * HHMMSS-<id>.wav per clip (clips already there are not fetched again). With
 * --stt each clip goes through the Mac's own speech server
 * (scripts/local-stt/server.py, default ws://127.0.0.1:5193) and its text is
 * written beside it (<clip>.local.txt, transcript.local.txt / .json). Nothing
 * is uploaded anywhere.
 *
 * The token: an API token with the `recordings:read` permission
 * (lianki.com/my/preferences → API tokens), from --token, LIANKI_RECORDINGS_TOKEN,
 * or ~/.config/lianki/recordings.token. Options: --out <dir>, --base <url>.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type PullFs,
  type WsLike,
  localSttClient,
  pullDay,
  retranscribe,
} from "./recordings-pull-lib";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : "";
};

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const day = opt("day") || today();
const out = opt("out") || join(homedir(), "lianki-recordings");
const base = (opt("base") || "https://lianki.com").replace(/\/+$/, "");
const tokenFile = join(homedir(), ".config/lianki/recordings.token");
const token =
  opt("token") ||
  process.env.LIANKI_RECORDINGS_TOKEN ||
  (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
if (!token) {
  console.error(
    "No token: make one with the recordings:read permission at https://lianki.com/my/preferences (API tokens),\n" +
      `then pass --token, set LIANKI_RECORDINGS_TOKEN, or save it to ${tokenFile}.`,
  );
  process.exit(2);
}

const fs: PullFs = {
  exists: async (p) => existsSync(p),
  mkdir: async (p) => void mkdirSync(p, { recursive: true }),
  write: async (p, d) => void (await Bun.write(p, d)),
  read: async (p) => new Uint8Array(await Bun.file(p).arrayBuffer()),
};
const tzMin = new Date().getTimezoneOffset();

const r = await pullDay({ base, token, fetch, fs, log: console.log, tzMin }, day, out);
const sttFlag = opt("stt");
if (sttFlag !== undefined && r.clips) {
  const url = sttFlag || "ws://127.0.0.1:5193";
  // The server accepts localhost origins (scripts/local-stt/server.py ORIGINS).
  const open = () =>
    new WebSocket(url, {
      headers: { Origin: "http://localhost:3000" },
    } as unknown as string[]) as unknown as WsLike;
  const c = localSttClient(open);
  try {
    await retranscribe(fs, r.dir, c.stt, console.log, tzMin);
  } finally {
    c.close();
  }
}
process.exit(r.failed ? 1 : 0);
