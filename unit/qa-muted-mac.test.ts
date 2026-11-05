/**
 * scripts/qa/with-muted-mac.sh under overlapping runs. The Mac is never touched:
 * osascript is a fake first on PATH that keeps the "muted" state in a file, and
 * `uname` is one too so this runs on CI's Linux. Run by hand on the owner's Mac
 * or in CI, nothing plays and nothing mutes.
 *
 * Why: overlapping qa:all runs left the owner's Mac muted (2026-11-05 14:21 JST).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/qa/with-muted-mac.sh");
// Many processes per test, and the machines running this are often busy.
const SLOW = 30_000;

let root: string;
let dir: string; // the script's state directory
let sound: string; // the fake Mac's "muted" state
let log: string; // what the fake osascript was asked
const running: Bun.Subprocess[] = [];

const FAKE_OSASCRIPT = `#!/bin/sh
echo "$2" >>"$FAKE_ROOT/log"
case "$2" in
  output*)
    if [ -f "$FAKE_ROOT/read-fails" ]; then exit 1; fi
    cat "$FAKE_ROOT/sound" ;;
  *without*)
    if [ -f "$FAKE_ROOT/unmute-fails" ]; then exit 1; fi
    echo false >"$FAKE_ROOT/sound" ;;
  *with*) echo true >"$FAKE_ROOT/sound" ;;
esac
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "muted-mac-"));
  dir = join(root, "state");
  sound = join(root, "sound");
  log = join(root, "log");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "osascript"), FAKE_OSASCRIPT);
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
  chmodSync(join(bin, "osascript"), 0o755);
  chmodSync(join(bin, "uname"), 0o755);
  writeFileSync(sound, "false\n");
  writeFileSync(log, "");
});

afterEach(() => {
  for (const p of running.splice(0)) p.kill(9);
  rmSync(root, { recursive: true, force: true });
});

const env = () => ({
  ...process.env,
  PATH: `${join(root, "bin")}:${process.env.PATH}`,
  FAKE_ROOT: root,
  LIANKI_QA_MUTE_DIR: dir,
});

const run = (...cmd: string[]) => {
  const p = Bun.spawn(["bash", SCRIPT, ...cmd], { env: env(), stdout: "ignore", stderr: "ignore" });
  running.push(p);
  return p;
};

/** A wrapped command that runs until `release` is called, and says when it started. */
const held = (name: string) => {
  const started = join(root, `${name}.started`);
  const go = join(root, `${name}.go`);
  const p = run(
    "sh",
    "-c",
    `touch "${started}"; until [ -f "${go}" ]; do sleep 0.02; done; exit 0`,
  );
  return {
    p,
    up: () => until(() => existsSync(started)),
    release: async () => {
      writeFileSync(go, "");
      return p.exited;
    },
  };
};

async function until(ok: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out; asked: ${readFileSync(log, "utf8")}`);
    await Bun.sleep(10);
  }
}

const muted = () => readFileSync(sound, "utf8").trim() === "true";
const leftovers = () => (existsSync(dir) ? readdirSync(dir) : []);
const deadPid = async () => {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
};

describe("one run", () => {
  test(
    "mutes for the command, restores after, keeps its exit code",
    async () => {
      const code = await run("sh", "-c", `cat "${sound}" >"${root}/during"; exit 7`).exited;
      expect(code).toBe(7);
      expect(readFileSync(join(root, "during"), "utf8").trim()).toBe("true");
      expect(muted()).toBe(false);
      await until(() => leftovers().length === 0);
    },
    SLOW,
  );

  test(
    "a Mac that was muted stays muted",
    async () => {
      writeFileSync(sound, "true\n");
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(true);
      expect(readFileSync(log, "utf8")).not.toContain("without");
      expect(existsSync(join(dir, "original-muted"))).toBe(false);
    },
    SLOW,
  );

  test(
    "SIGTERM still restores",
    async () => {
      const a = held("a");
      await a.up();
      expect(muted()).toBe(true);
      a.p.kill("SIGTERM");
      await a.release();
      expect(await a.p.exited).toBe(143);
      expect(muted()).toBe(false);
    },
    SLOW,
  );
});

describe("overlapping runs", () => {
  test(
    "only the first saves the original, only the last restores",
    async () => {
      const a = held("a");
      await a.up();
      const b = held("b");
      await b.up();
      // b started on a muted Mac; that must not become the original.
      expect(readFileSync(join(dir, "original-muted"), "utf8").trim()).toBe("false");
      await a.release();
      expect(muted()).toBe(true);
      const c = held("c");
      await c.up();
      await b.release();
      expect(muted()).toBe(true);
      await c.release();
      expect(muted()).toBe(false);
      const reads = readFileSync(log, "utf8").split("\n");
      expect(reads.indexOf("output muted of (get volume settings)")).toBe(0);
    },
    SLOW,
  );

  test(
    "a burst that starts and ends together restores once",
    async () => {
      const exits = Array.from({ length: 8 }, () => run("sleep", "0.05").exited);
      await Promise.all(exits);
      expect(muted()).toBe(false);
      await until(() => leftovers().length === 0);
    },
    SLOW,
  );
});

describe("killed runs and leftovers", () => {
  test(
    "kill -9 of the only run: the watcher restores",
    async () => {
      const a = held("a");
      await a.up();
      expect(muted()).toBe(true);
      a.p.kill(9);
      await until(() => !muted());
      await until(() => leftovers().length === 0);
      await a.release();
    },
    SLOW,
  );

  test(
    "kill -9 of the run's whole process group: the watcher is outside it",
    async () => {
      const p = Bun.spawn(["bash", SCRIPT, "sleep", "30"], {
        env: env(),
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      running.push(p);
      await until(() => readdirSync(existsSync(dir) ? dir : root).includes(`holder.${p.pid}`));
      expect(muted()).toBe(true);
      process.kill(-p.pid, "SIGKILL");
      await until(() => !muted());
      await until(() => leftovers().length === 0);
    },
    SLOW,
  );

  test(
    "kill -9 of one run leaves the mute with the other, which restores",
    async () => {
      const a = held("a");
      await a.up();
      const b = held("b");
      await b.up();
      a.p.kill(9);
      await a.p.exited;
      await Bun.sleep(150);
      expect(muted()).toBe(true);
      await b.release();
      expect(muted()).toBe(false);
      await a.release();
    },
    SLOW,
  );

  test(
    "a holder whose pid is dead does not count",
    async () => {
      mkdirSync(dir);
      writeFileSync(join(dir, `holder.${await deadPid()}`), "");
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(false);
    },
    SLOW,
  );

  test(
    "a holder whose pid was reused by another process does not count",
    async () => {
      mkdirSync(dir);
      writeFileSync(join(dir, `holder.${process.pid}`), "Thu  1 Jan 00:00:00 1970\n");
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(false);
    },
    SLOW,
  );

  test(
    "a live holder from an older checkout (empty file) still counts",
    async () => {
      mkdirSync(dir);
      const old = join(dir, `holder.${process.pid}`);
      writeFileSync(old, "");
      writeFileSync(join(dir, "original-muted"), "false\n");
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(true);
      rmSync(old);
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(false);
    },
    SLOW,
  );

  test(
    "a crashed run's saved original is kept by the next run",
    async () => {
      mkdirSync(dir);
      writeFileSync(join(dir, "original-muted"), "false\n");
      writeFileSync(sound, "true\n");
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(false);
    },
    SLOW,
  );

  test(
    "a mutex left by a dead owner is broken at once",
    async () => {
      mkdirSync(join(dir, "mutex"), { recursive: true });
      writeFileSync(join(dir, "mutex", "pid"), `${await deadPid()}\n`);
      const t = Date.now();
      expect(await run("true").exited).toBe(0);
      expect(Date.now() - t).toBeLessThan(20_000);
      expect(muted()).toBe(false);
    },
    SLOW,
  );

  test(
    "a mutex with a live owner is waited for",
    async () => {
      mkdirSync(join(dir, "mutex"), { recursive: true });
      writeFileSync(join(dir, "mutex", "pid"), `${process.pid}\n`);
      const p = run("true");
      await Bun.sleep(300);
      expect(readFileSync(log, "utf8")).toBe("");
      expect(p.exitCode).toBeNull();
      rmSync(join(dir, "mutex"), { recursive: true });
      expect(await p.exited).toBe(0);
      expect(muted()).toBe(false);
    },
    SLOW,
  );
});

describe("osascript failing", () => {
  test(
    "an unreadable state is not saved as muted: the Mac comes back",
    async () => {
      writeFileSync(join(root, "read-fails"), "");
      const a = held("a");
      await a.up();
      expect(muted()).toBe(true);
      expect(readFileSync(join(dir, "original-muted"), "utf8").trim()).toBe("unknown");
      rmSync(join(root, "read-fails"));
      await a.release();
      expect(muted()).toBe(false);
    },
    SLOW,
  );

  test(
    "an unmute that fails keeps the original for the next run",
    async () => {
      writeFileSync(join(root, "unmute-fails"), "");
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(true);
      expect(readFileSync(join(dir, "original-muted"), "utf8").trim()).toBe("false");
      rmSync(join(root, "unmute-fails"));
      expect(await run("true").exited).toBe(0);
      expect(muted()).toBe(false);
      expect(existsSync(join(dir, "original-muted"))).toBe(false);
    },
    SLOW,
  );
});

test(
  "the wrapper's output pipe closes with it: the watcher does not hold it open",
  async () => {
    const p = Bun.spawn(["bash", SCRIPT, "echo", "hi"], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    running.push(p);
    expect((await new Response(p.stdout).text()).trim()).toBe("hi");
    expect(await new Response(p.stderr).text()).toBe("");
  },
  SLOW,
);
