/**
 * The arguments of scripts/dev/progress.ts, parsed into what it sends.
 * Kept apart from the CLI so it is unit-tested without the network.
 */
import {
  PROGRESS_KINDS,
  PROGRESS_STATUSES,
  type ProgressReport,
  isProgressId,
  parseProgressReport,
  parseTtl,
} from "../../lib/progress";

export const PROGRESS_USAGE = `usage:
  bun scripts/dev/progress.ts --agent <name> --task "<text>" --status <${PROGRESS_STATUSES.join("|")}>
      [--path /words/prefetch | --id <slug> [--parent <id>]] [--done] [--pct 40] [--eta 15m]
      [--pr 299] [--note "..."] [--needs "approve PR #299"] [--kind <${PROGRESS_KINDS.join("|")}>]
      [--ref <id>] [--action "<command or URL>"] [--link https://…] [--rev N] [--human]
  bun scripts/dev/progress.ts grant --node <id> --agent <name> [--ttl 8h]
  bun scripts/dev/progress.ts resolve --id <id> [--note "the answer"]
  bun scripts/dev/progress.ts show
Every form takes --token <token> (else LIANKI_PROGRESS_TOKEN, PROGRESS_TOKEN, or .dev.vars).`;

export type ProgressCommand = { token?: string } & (
  | { cmd: "report"; report: ProgressReport }
  | { cmd: "grant"; node: string; agent: string; ttl: string }
  | { cmd: "resolve"; id: string; note?: string }
  | { cmd: "show" }
);

const STRINGS = [
  "agent",
  "task",
  "status",
  "eta",
  "note",
  "id",
  "parent",
  "path",
  "needs",
  "kind",
  "ref",
  "action",
  "link",
  "token",
  "node",
  "ttl",
] as const;
const NUMBERS = ["pct", "pr", "rev"] as const;
const SWITCHES = ["done", "human"] as const;

/** argv (without the runtime and script) → the command, or an Error naming what is wrong. */
export function parseProgressArgs(argv: string[]): ProgressCommand | Error {
  const sub = ["grant", "resolve", "show"].includes(argv[0] ?? "") ? argv[0]! : "report";
  const raw: Record<string, unknown> = {};
  for (let i = sub === "report" ? 0 : 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const m = /^--([a-z]+)(?:=(.*))?$/s.exec(arg);
    if (!m) return new Error(`unexpected argument: ${arg}`);
    const name = m[1]!;
    if ((SWITCHES as readonly string[]).includes(name)) {
      raw[name] = true;
      continue;
    }
    const value = m[2] ?? argv[++i];
    if (value === undefined) return new Error(`--${name} needs a value`);
    if ((STRINGS as readonly string[]).includes(name)) raw[name] = value;
    else if ((NUMBERS as readonly string[]).includes(name)) {
      const n = Number(value.replace(/^#|%$/g, ""));
      if (value.trim() === "" || !Number.isFinite(n))
        return new Error(`--${name} must be a number`);
      raw[name] = n;
    } else return new Error(`unknown flag: --${name}`);
  }
  const token = typeof raw.token === "string" ? { token: raw.token } : {};
  if (sub === "show") return { cmd: "show", ...token };
  if (sub === "grant") {
    if (!isProgressId(raw.node)) return new Error("grant needs --node <id>");
    if (typeof raw.agent !== "string" || !raw.agent) return new Error("grant needs --agent <name>");
    const ttl = typeof raw.ttl === "string" ? raw.ttl : "8h";
    const ms = parseTtl(ttl);
    if (ms instanceof Error) return new Error(`--ttl: ${ms.message}`);
    return { cmd: "grant", node: raw.node, agent: raw.agent, ttl, ...token };
  }
  if (sub === "resolve") {
    if (!isProgressId(raw.id)) return new Error("resolve needs --id <id>");
    return {
      cmd: "resolve",
      id: raw.id,
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...token,
    };
  }
  if (raw.done) raw.status = "done";
  if (raw.path !== undefined) {
    if (raw.id !== undefined && raw.id !== raw.path) return new Error("--path and --id differ");
    raw.id = raw.path;
  }
  if (raw.human) {
    raw.assignee = { type: "human", name: raw.agent };
    delete raw.agent;
  }
  for (const k of ["path", "done", "human", "token"]) delete raw[k];
  const report = parseProgressReport(raw);
  return report instanceof Error ? report : { cmd: "report", report, ...token };
}
