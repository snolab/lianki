import { spawn } from "node:child_process";
import { join } from "node:path";
import { BRIDGE_DEFAULTS } from "./chat-bridge.mjs";

/** Opt-in adapter to existing owner-grant edit/merge guards. No token files read here. */
export function applyGrantPolish(repo, turn, suggestion, { signal, spawnProcess = spawn } = {}) {
  const ids = turn.turnIds ?? [turn.id];
  const args = [join(repo, "scripts/dev/eval.ts"), "edit", "--no-pair",
    ...(ids.length > 1 ? ["--merge", ids.join(","), "--text", suggestion] : [ids[0], suggestion])];
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(BRIDGE_DEFAULTS.deliveryTimeoutMs);
    const p = spawnProcess("bun", args, { cwd: repo, signal: signal ? AbortSignal.any([signal, deadline]) : deadline, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    p.stdout.on("data", (chunk) => { if (output.length < 65536) output += chunk; });
    p.once("error", () => reject(new Error("polish transport unavailable")));
    p.once("exit", (code) => {
      if (code !== 0) return reject(new Error("polish refused; raw retained"));
      let result;
      try { result = JSON.parse(output.trim().split("\n").at(-1)); } catch {}
      if (result?.type !== "edited" || result.id !== ids[0] || result.text !== suggestion ||
        (ids.length > 1 && JSON.stringify(result.passage?.ids) !== JSON.stringify(ids)))
        return reject(new Error("polish not confirmed; raw retained"));
      resolve(result);
    });
  });
}
