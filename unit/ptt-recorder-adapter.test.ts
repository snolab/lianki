import { expect, test } from "bun:test";

test("PTT recorder audio adapter obeys cap and acquisition cancellation using inert nodes", () => {
  const run = Bun.spawnSync(["bun", "test", "./ptt-recorder-adapter.ts"], {
    cwd: `${import.meta.dir}/support`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = `${run.stdout.toString()}${run.stderr.toString()}`;
  if (run.exitCode !== 0) console.error(out);
  expect(run.exitCode).toBe(0);
  expect(out).toMatch(/\b2 pass\b/);
  expect(out).toMatch(/\b0 fail\b/);
});
