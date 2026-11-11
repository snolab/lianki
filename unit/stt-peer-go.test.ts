/**
 * stt-peer (scripts/local-stt/stt-peer, Go + pion): its own tests — the worker
 * key (0600, never overwritten, a loose or symlinked key refused), the
 * registry's challenge signature, and a page reaching a fake speech server over
 * a real WebRTC DataChannel through it (order kept, the final's audio booked,
 * a session past capacity refused). Runs `go test` where Go is installed (on
 * the speech server: ~/.cache/lianki-stt/toolchain/go); skipped elsewhere (CI).
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LOCAL_GO = join(homedir(), ".cache/lianki-stt/toolchain/go/bin/go");
const GO = existsSync(LOCAL_GO) ? LOCAL_GO : Bun.which("go");
const DIR = resolve(import.meta.dir, "../scripts/local-stt/stt-peer");

describe.skipIf(!GO)("stt-peer", () => {
  it("go test passes", () => {
    const r = Bun.spawnSync([GO as string, "test", "-count=1", "./..."], {
      cwd: DIR,
      env: {
        ...process.env,
        GOTOOLCHAIN: "local",
        GOFLAGS: "-modcacherw",
        GOPATH: process.env.GOPATH ?? join(homedir(), ".cache/lianki-stt/gopath"),
      },
    });
    expect({ code: r.exitCode, out: r.exitCode ? `${r.stdout}${r.stderr}` : "" }).toEqual({
      code: 0,
      out: "",
    });
  }, 120_000);
});
