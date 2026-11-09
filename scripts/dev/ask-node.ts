/**
 * Ask cards on their node (docs/planning-tools.md, step 7; docs/lianki-dev-cli.md,
 * "Asks on a node"). An agent lane's `lianki-dev ask` names the state tree
 * node it is about (`--node /path`, else LIANKI_TASK_PATH); the question, and
 * with --wait the answer, are written on that node as notes. Kept apart from
 * lianki-dev.ts so it is unit-tested without sockets or the network.
 */
import { type ProgressEntry, isPathId, isProgressId } from "../../lib/progress";

/** `--node /path` taken out of an ask's arguments; LIANKI_TASK_PATH when none. */
export function askNode(
  rest: readonly string[],
  env: Record<string, string | undefined>,
  lane: string | undefined,
): { node?: string; rest: string[] } | Error {
  const out: string[] = [];
  let node: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--node") {
      node = rest[++i];
      if (!node) return new Error("--node needs a /path");
    } else out.push(a);
  }
  node ??= env.LIANKI_TASK_PATH?.trim() || undefined;
  if (node !== undefined && !(isProgressId(node) && isPathId(node)))
    return new Error(`--node: not a node path: ${node}`);
  if (!node && lane)
    return new Error(
      `ask from a lane needs --node /path: the state tree node the question is about (or LIANKI_TASK_PATH)`,
    );
  return node ? { node, rest: out } : { rest: out };
}

/** The questions of an ask's arguments (each --q), in order. */
export const askQuestions = (rest: readonly string[]) =>
  rest.flatMap((a, i) => (rest[i - 1] === "--q" ? [a] : []));

/** Labels of a tap: a list, a {question: [labels]} map, or a string; flattened. */
const flatLabels = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.flatMap(flatLabels)
      : v && typeof v === "object"
        ? Object.values(v).flatMap(flatLabels)
        : [];

/**
 * The answer in an ask's output (eval.ts's {"type":"answered",labels}, the
 * lianki CLI's {answer:{labels}} or its envelope's data), or null: not
 * answered (no --wait, a timeout).
 */
export function askAnswer(out: string): string | null {
  for (const line of out.split("\n").reverse()) {
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const d = m?.data && typeof m.data === "object" ? m.data : m;
    const labels =
      d?.type === "answered" ? (d.labels ?? d.answer) : d?.answer ? d.answer.labels : undefined;
    const said = flatLabels(labels).filter((s) => s.trim());
    if (said.length) return said.join(", ");
  }
  return null;
}

/** The report that adds `note` to `node`, keeping its title and status, written as `agent`. */
export function nodeNote(
  node: Pick<ProgressEntry, "id" | "task" | "status" | "creator">,
  note: string,
  agent?: string,
): Record<string, unknown> {
  return {
    id: node.id,
    agent: agent?.trim() || node.creator,
    task: node.task,
    status: node.status,
    note: note.slice(0, 280),
  };
}
