/**
 * scripts/local-stt/test_lang_pick.py: the short-utterance language pick
 * (engines.choose), the numpy filterbank and the int8 scorer (docs/local-stt.md,
 * "Short utterances and the language"). Python, so it runs only where the local
 * STT venv is; elsewhere (CI) it skips. The scorer test also needs the model.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PY = join(homedir(), ".cache/lianki-stt/venv/bin/python");

describe.skipIf(!existsSync(PY))("local STT language pick (python)", () => {
  it("passes its unittest suite", () => {
    const r = Bun.spawnSync(
      [PY, "-I", resolve(import.meta.dir, "../scripts/local-stt/test_lang_pick.py")],
      // One thread: never compete with the live STT for the CPU.
      { env: { ...process.env, OMP_NUM_THREADS: "1" }, stdout: "pipe", stderr: "pipe" },
    );
    const out = r.stderr.toString();
    expect(out).toMatch(/\nOK/);
    expect(r.exitCode).toBe(0);
  }, 60_000);
});
