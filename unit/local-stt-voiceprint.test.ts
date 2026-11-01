/**
 * scripts/local-stt/test_voiceprint.py: the server's side of the voiceprint
 * (docs/local-stt.md, "Voiceprint"): the per-duration bands and the noise
 * gate, the store's file modes (0700 / 0600, no symlinks), delete (one
 * device, all, never the clips), enrolment checks, and the real server's
 * protocol with `--engine fake --speaker fake` (consent gating, enrol,
 * verify, delete). Temporary folders and synthetic tones only. Python, so it
 * runs only where the local STT venv is; elsewhere (CI) it skips.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");
const hasVenv =
  existsSync(PY) &&
  Bun.spawnSync([PY, "-I", "-c", "import websockets, numpy, soundfile"]).exitCode === 0;

describe.skipIf(!hasVenv)("local STT voiceprint (python)", () => {
  it("passes its unittest suite", () => {
    const r = Bun.spawnSync(
      [PY, "-I", resolve(import.meta.dir, "../scripts/local-stt/test_voiceprint.py")],
      // One thread: never compete with the live STT for the CPU.
      { env: { ...process.env, OMP_NUM_THREADS: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    const out = r.stderr.toString();
    expect(out).toMatch(/\nOK/);
    expect(r.exitCode).toBe(0);
  }, 120_000);
});
