/**
 * The controller side of the debug hub, shared by scripts/dev/eval.ts and
 * scripts/dev/shot.ts: where the grant tokens live, opening the controller
 * socket, resuming a saved eval grant (no prompt) or pairing (at most once
 * per process), and running code on the pages. The rules for when to resume
 * and when to pair are in ./eval-grant.ts.
 */
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  evalStep,
  freshenedGrantFile,
  grantFileBody,
  readGrantFile,
  GRANT_INVALID,
} from "./eval-grant";

export const BASE = (process.env.LIANKI_URL ?? "https://lianki.com").replace(/\/+$/, "");
/** How long to wait for the pages' results after sending. */
export const RESULT_MS = 20_000;
const PAIR_MS = 2 * 60_000;

export type Msg = Record<string, unknown> & { type?: string };

/** The main checkout's root, shared by every worktree: where the grant tokens live. */
function mainRoot() {
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dir,
  });
  const common = git.success ? git.stdout.toString().trim() : "";
  return common ? dirname(common) : join(import.meta.dir, "..", "..");
}
const tokenFile = (name: string, env: string) =>
  process.env[env] ? resolve(process.env[env]) : join(mainRoot(), name);
/** The chat grant (30 days, chat only). */
export const TOKEN_FILE = tokenFile(".debug-chat-token.json", "LIANKI_CHAT_TOKEN_FILE");
/** The eval grant (8 hours, eval and chat). */
export const EVAL_TOKEN_FILE = tokenFile(".debug-eval-token.json", "LIANKI_EVAL_TOKEN_FILE");
const loadFrom = (file: string) => {
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  return readGrantFile(text, Date.now());
};
export const saveTo = (file: string, token: string, until: number) => {
  writeFileSync(file, grantFileBody(token, until), { mode: 0o600 });
  chmodSync(file, 0o600);
};
/** A renewal (or a resume's until) for the eval token this socket holds: rewrite its file. */
const freshen = (token: string, data: string) => {
  if (!data.includes('"renewed"') && !data.includes('"approved"')) return;
  try {
    let text: string | undefined;
    try {
      text = readFileSync(EVAL_TOKEN_FILE, "utf8");
    } catch {}
    const m = JSON.parse(data) as Msg;
    const body = freshenedGrantFile(text, token, m);
    if (!body) return;
    writeFileSync(EVAL_TOKEN_FILE, body, { mode: 0o600 });
    chmodSync(EVAL_TOKEN_FILE, 0o600);
    if (m.type === "renewed")
      console.error(`Eval grant renewed until ${new Date(Number(m.until)).toLocaleString()}.`);
  } catch {}
};
export const loadToken = () => loadFrom(TOKEN_FILE);
export const loadEvalToken = () => loadFrom(EVAL_TOKEN_FILE);
/** A grant that may chat: the chat grant, else the eval grant (eval implies chat). */
export const chatGrant = () => {
  const chat = loadToken();
  if (chat) return { token: chat, file: TOKEN_FILE };
  const ev = loadEvalToken();
  return ev ? { token: ev, file: EVAL_TOKEN_FILE } : undefined;
};

/**
 * Who this controller is: `label` is shown to the owner on a pairing;
 * `labelFlag` (the --label given, if any) renames a resumed grant; `forEmail`
 * asks for a friend's preview; `noPair` fails instead of asking the owner.
 */
export type ControllerOpts = {
  label: string;
  labelFlag?: string;
  forEmail?: string;
  noPair?: boolean;
  /** The state-tree node this controller listens and speaks at (`?node=`); absent = "/". */
  node?: string;
  /** The node's assignee id (`?agent=`). */
  agent?: string;
};

/** The controller socket's plumbing for one process (it pairs at most once). */
export function controller({ label, labelFlag, forEmail, noPair, node, agent }: ControllerOpts) {
  const where = `${node ? `&node=${encodeURIComponent(node)}` : ""}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`;
  /** Resuming a grant without --label keeps the label it was approved under. */
  const controlUrl = (
    token?: string,
    forEmail?: string,
    scope: "chat" | "eval" = "eval",
    beat = false,
  ) =>
    `${BASE.replace(/^http/, "ws")}/api/version/debug/control?label=${encodeURIComponent(token ? (labelFlag ?? "") : label)}&scope=${scope}${forEmail ? `&for=${encodeURIComponent(forEmail)}` : ""}${beat ? "&beat=1" : ""}${where}`;
  /**
   * Bun's WebSocket takes headers, so the grant goes in one, never in the URL
   * (the repo type-checks with the DOM lib's constructor, hence the cast).
   * `forEmail` asks for a pairing on that friend's pages, which needs the grant.
   * `scope` is what a fresh pairing asks for: "chat" (the 30-day grant, for the
   * listener) or "eval" (code and chat for 8 hours); the owner's Allow grants it.
   * `beat`: a heartbeat-only socket (`busy`), not a session nor a listener.
   */
  const openControl = (
    token?: string,
    forEmail?: string,
    scope: "chat" | "eval" = "eval",
    beat = false,
  ) => {
    if (!token) return new WebSocket(controlUrl(undefined, undefined, scope));
    const ws = new WebSocket(controlUrl(token, forEmail, scope, beat), {
      headers: { "x-debug-token": token },
    } as unknown as string[]);
    // The hub renews the eval grant on use (docs/monitoring.md, "Renewal"):
    // keep the token file's `until` in step, so the next run resumes, not pairs.
    ws.addEventListener("message", (e) => freshen(token, String(e.data)));
    return ws;
  };

  /**
   * Open the controller socket and wait for the owner's answer — once: a
   * timeout, Deny or close rejects, and nothing here asks again. The owner's
   * Allow hands over the eval grant, saved for the next run.
   */
  function pair(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      if (forEmail) {
        const grant = chatGrant();
        if (!grant)
          return reject(
            new Error(`--for needs the chat grant in ${TOKEN_FILE}: run \`eval.ts chat\` first`),
          );
        ws = openControl(grant.token, forEmail);
      } else ws = openControl();
      const give = setTimeout(() => {
        ws.close();
        reject(new Error("no answer on the page within 2 minutes"));
      }, PAIR_MS);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Msg;
        if (m.type === "pending" && forEmail)
          console.error(
            `Asking ${forEmail} for a 1-hour preview. Tell them in the chat to allow code  ${m.code}\n` +
              `  e.g. bun scripts/dev/eval.ts say --to ${forEmail} "Tap Allow on the preview request with code ${m.code}"`,
          );
        else if (m.type === "pending")
          console.error(
            `Pairing as "${label}" (code and chat, 8 hours). On the page, tap Allow if it shows code  ${m.code}`,
          );
        else if (m.type === "approved") {
          clearTimeout(give);
          ws.onmessage = null;
          if (!forEmail && typeof m.token === "string")
            saveTo(EVAL_TOKEN_FILE, m.token, Number(m.until));
          console.error(`Approved until ${new Date(Number(m.until)).toLocaleTimeString()}.`);
          resolve(ws);
        } else if (m.type === "error" || m.type === "denied" || m.type === "expired") {
          clearTimeout(give);
          reject(new Error(String(m.error ?? m.type)));
        }
      };
      ws.onclose = (e) => {
        clearTimeout(give);
        reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
      };
    });
  }

  /**
   * Reconnect with the saved eval grant: the approved socket, or `rejected`
   * when the hub no longer knows the token (4498). Never prompts.
   */
  function resumeEval(token: string): Promise<{ ws: WebSocket } | { rejected: true }> {
    return new Promise((resolve, reject) => {
      const ws = openControl(token);
      const give = setTimeout(() => {
        ws.close();
        reject(new Error("no answer from the hub within 15 s"));
      }, 15_000);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Msg;
        if (m.type !== "approved") return;
        clearTimeout(give);
        ws.onmessage = null;
        ws.onclose = null;
        if (m.scope !== "eval") {
          ws.close();
          return reject(new Error(`${EVAL_TOKEN_FILE} holds a ${String(m.scope)} grant, not eval`));
        }
        console.error(
          `Resumed the eval grant until ${new Date(Number(m.until)).toLocaleString()}.`,
        );
        resolve({ ws });
      };
      ws.onclose = (e) => {
        clearTimeout(give);
        if (e.code === GRANT_INVALID) resolve({ rejected: true });
        else reject(new Error(`socket closed (${e.code}${e.reason ? ` ${e.reason}` : ""})`));
      };
    });
  }

  /** Whether this process has asked the owner already: it does so at most once. */
  let paired = false;

  /**
   * An approved eval socket: the saved grant first; a pairing only when there
   * is none or the hub refused it, at most once per process, never with
   * --no-pair. A resume that fails for any other reason (network) fails —
   * it never falls back to prompting. (evalStep has the rules.)
   */
  async function evalSocket(): Promise<WebSocket> {
    const token = forEmail ? undefined : loadEvalToken();
    let step = evalStep({ token, noPair, paired });
    if (step.kind === "resume") {
      const r = await resumeEval(step.token);
      if ("ws" in r) return r.ws;
      rmSync(EVAL_TOKEN_FILE, { force: true });
      console.error("Saved eval grant refused (expired or ended).");
      step = evalStep({ token, rejected: true, noPair, paired });
    }
    if (step.kind === "fail") throw new Error(step.error);
    paired = true;
    return pair();
  }

  return { openControl, pair, resumeEval, evalSocket };
}

/**
 * Called with each streamed piece's chunk ({type:"chunk", id, part, seq,
 * total, data, page}) of the command `run` sent, as it arrives.
 */
export type OnChunk = (m: Msg) => void;

/**
 * Send one command over an approved socket; resolve with every page's
 * result, or with what came after `waitMs` (RESULT_MS) — a wait that each
 * streamed chunk (`onChunk`) starts again.
 */
export function run(
  ws: WebSocket,
  code: string,
  target?: string,
  { waitMs = RESULT_MS, onChunk }: { waitMs?: number; onChunk?: OnChunk } = {},
): Promise<Msg[]> {
  return new Promise((resolve, reject) => {
    let id: string | undefined;
    let expected = Infinity;
    const results: Msg[] = [];
    const done = () => {
      clearTimeout(give);
      ws.removeEventListener("message", on);
      resolve(results);
    };
    let give = setTimeout(done, waitMs);
    const on = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as Msg;
      if (m.type === "sent" && !id) {
        id = String(m.id);
        expected = Number(m.delivered);
        console.error(`eval ${id}: delivered to ${expected} page(s)`);
      } else if (m.type === "chunk" && m.id === id) {
        clearTimeout(give);
        give = setTimeout(done, waitMs);
        onChunk?.(m);
      } else if (m.type === "result" && m.id === id) results.push(m);
      else if (m.type === "error" || m.type === "expired" || m.type === "revoked") {
        clearTimeout(give);
        ws.removeEventListener("message", on);
        return reject(new Error(String(m.error ?? m.type)));
      }
      if (results.length >= expected) done();
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ type: "eval", code, target }));
  });
}
