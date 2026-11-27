// Mic recordings helpers shared by `lianki recordings` (cli.mjs) and the MCP
// tools (mcp-tools.mjs / workers/mcp). Runtime-neutral (no node: imports).
// Matches lib/recordings.ts constants and query rules.

import { CliError, EXIT } from "./api.mjs";

export const RECORDINGS_PATH = "/api/my/recordings";
export const RECORDING_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
export const RECORDING_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const RECORDING_MAX_BYTES = 1_300_000;
export const RECORDING_LIST_DEFAULT = 20;
export const RECORDING_LIST_MAX = 200;

export function validateRecordingId(id) {
  if (typeof id !== "string" || !RECORDING_ID_RE.test(id))
    throw new CliError(
      "usage",
      EXIT.usage,
      "recording id must be 16–32 characters (letters, digits, _ or -)",
    );
  return id;
}

export function validateRecordingDay(day) {
  if (typeof day !== "string" || !RECORDING_DAY_RE.test(day))
    throw new CliError("usage", EXIT.usage, "--day must be YYYY-MM-DD (UTC)");
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day)
    throw new CliError("usage", EXIT.usage, `invalid calendar day "${day}"`);
  return day;
}

export function recordingsListQuery({ day, before, limit } = {}) {
  if (day !== undefined && day !== null) {
    const validDay = validateRecordingDay(day);
    if (before !== undefined && before !== null)
      throw new CliError("usage", EXIT.usage, "--day cannot be combined with --before");
    if (limit !== undefined && limit !== null)
      throw new CliError("usage", EXIT.usage, "--day cannot be combined with --limit");
    return { day: validDay };
  }
  const out = {};
  if (before !== undefined && before !== null) {
    if (typeof before !== "number" || !Number.isSafeInteger(before) || before < 0)
      throw new CliError(
        "usage",
        EXIT.usage,
        "--before must be a non-negative integer timestamp (ms)",
      );
    out.before = before;
  }
  const n = limit === undefined || limit === null ? RECORDING_LIST_DEFAULT : limit;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > RECORDING_LIST_MAX)
    throw new CliError("usage", EXIT.usage, `--limit must be an integer 1–${RECORDING_LIST_MAX}`);
  out.limit = n;
  return out;
}

export function clipSummary(x) {
  return {
    id: x.id,
    day: x.day ?? null,
    at: x.at,
    durationMs: x.durationMs,
    bytes: x.bytes,
    mode: x.mode,
    source: x.source,
    device: x.device,
    speaker: x.speaker ?? null,
    text: x.text ?? "",
  };
}

/** Pure JS chunked base64 encoding (8192-byte slices, no node: imports). */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < u8.length; i += CHUNK) {
    const slice = u8.subarray(i, i + CHUNK);
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}
