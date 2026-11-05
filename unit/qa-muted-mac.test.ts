/**
 * scripts/qa/with-muted-mac.sh under overlapping runs. The Mac is never touched:
 * LIANKI_QA_OSASCRIPT names a fake that keeps the state in files, so a process
 * that outlives it finds nothing rather than the real osascript. `uname` is a
 * fake too, so this runs on CI's Linux. Nothing plays and nothing mutes.
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

const SOURCE = join(import.meta.dir, "../scripts/qa/with-muted-mac.sh");
// Many processes per test, and the machines running this are often busy.
const SLOW = 30_000;

let root: string;
let script: string; // a copy per test, so every process it starts is findable by path
let dir: string; // the script's state directory
let sound: string; // the fake Mac's "muted" state
let log: string; // what the fake osascript was asked
const running: Bun.Subprocess[] = [];

const FAKE_OSASCRIPT = `#!/bin/sh
echo "$2" >>"$FAKE_ROOT/log"
case "$2" in
  "output volume"*) cat "$FAKE_ROOT/volume" ;;
  "set volume output volume "*)
    echo "\${2##* }" >"$FAKE_ROOT/volume"
    echo false >"$FAKE_ROOT/sound" ;;
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
  writeFileSync(join(root, "volume"), "25\n");
  writeFileSync(log, "");
  script = join(root, "with-muted-mac.sh");
  writeFileSync(script, readFileSync(SOURCE));
});

/** Processes still running from this test's copy of the script or its temp dir. */
const alive = () =>
  new TextDecoder()
    .decode(Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout)
    .split("\n")
    .filter((l) => l.includes(root));

// Watchers and wrapped commands must end by themselves once their run and its
// state are gone. They once did not: 140 watchers spun for hours and loaded the
// owner's Mac (2026-11-05). Anything left is killed, then fails the test.
afterEach(async () => {
  for (const p of running.splice(0)) p.kill(9);
  rmSync(root, { recursive: true, force: true });
  const end = Date.now() + 15_000;
  while (alive().length && Date.now() < end) await Bun.sleep(50);
  const left = alive();
  for (const l of left) {
    try {
      process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL");
    } catch {}
  }
  expect(left).toEqual([]);
}, SLOW);

const env = () => ({
  ...process.env,
  PATH: `${join(root, "bin")}:${process.env.PATH}`,
  FAKE_ROOT: root,
  LIANKI_QA_OSASCRIPT: join(root, "bin", "osascript"),
  LIANKI_QA_MUTE_DIR: dir,
});

const run = (...cmd: string[]) => {
  const p = Bun.spawn(["bash", script, ...cmd], { env: env(), stdout: "ignore", stderr: "ignore" });
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
    // It may outlive a killed wrapper, so it also ends when the test's dir goes.
    `touch "${started}"; until [ -f "${go}" ] || [ ! -d "${root}" ]; do sleep 0.05; done; exit 0`,
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
const leftovers = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f !== "log") : []);
const volume = () => readFileSync(join(root, "volume"), "utf8").trim();
const deadPid = async () => {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
};

describe("the volume", () => {
  test(
    "moved during a run: put back, and the sound comes back too",
    async () => {
      const a = held("a");
      await a.up();
      writeFileSync(join(root, "volume"), "80\n");
      await a.release();
      expect(volume()).toBe("25");
      expect(muted()).toBe(false);
      expect(leftovers()).toEqual([]);
    },
    SLOW,
  );

  test(
    "moved during a run on a muted Mac: put back, and still muted",
    async () => {
      writeFileSync(sound, "true\n");
      const a = held("a");
      await a.up();
      writeFileSync(join(root, "volume"), "80\n");
      await a.release();
      expect(volume()).toBe("25");
      expect(muted()).toBe(true);
    },
    SLOW,
  );

  test(
    "unmoved: never set",
    async () => {
      expect(await run("true").exited).toBe(0);
      expect(readFileSync(log, "utf8")).not.toContain("set volume output volume");
    },
    SLOW,
  );

  test(
    "a crashed run's volume is restored by the next run",
    async () => {
      mkdirSync(dir);
      writeFileSync(join(dir, "original-muted"), "false\n");
      writeFileSync(join(dir, "original-volume"), "40\n");
      expect(await run("true").exited).toBe(0);
      expect(volume()).toBe("40");
      expect(muted()).toBe(false);
    },
    SLOW,
  );
});

test(
  "every mute and restore is logged with its command, for the next 'why was it muted'",
  async () => {
    expect(await run("sh", "-c", "exit 0").exited).toBe(0);
    const lines = readFileSync(join(dir, "log"), "utf8").trim().split("\n");
    expect(lines[0]).toContain("mute: original=false");
    expect(lines[0]).toContain("cmd=sh -c exit 0");
    expect(lines[1]).toContain("restored: unmuted");
  },
  SLOW,
);

test(
  "a fake that is gone reaches nothing, not the real osascript",
  async () => {
    rmSync(join(root, "bin", "osascript"));
    expect(await run("sh", "-c", "exit 5").exited).toBe(5);
    expect(existsSync(dir)).toBe(false);
  },
  SLOW,
);

describe("nothing outlives a run", () => {
  test(
    "a clean run leaves no process behind, not even for a moment after it exits",
    async () => {
      expect(await run("true").exited).toBe(0);
      await until(() => alive().length === 0, 3000);
    },
    SLOW,
  );

  test(
    "a watcher whose state directory is gone ends instead of waiting on the lock",
    async () => {
      const a = held("a");
      await a.up();
      rmSync(dir, { recursive: true, force: true });
      a.p.kill(9);
      await a.p.exited;
      writeFileSync(join(root, "a.go"), "");
      await until(() => alive().length === 0);
    },
    SLOW,
  );

  test(
    "a run whose state directory goes mid-run ends with its command's code",
    async () => {
      const code = await run("sh", "-c", `rm -rf "${dir}"; exit 3`).exited;
      expect(code).toBe(3);
      await until(() => alive().length === 0);
    },
    SLOW,
  );

  test(
    "a lock it cannot take: the command still runs, unmuted",
    async () => {
      // A stale mutex gets broken, so only a mkdir that always refuses it stays locked.
      const fake = join(root, "bin", "mkdir");
      writeFileSync(
        fake,
        `#!/bin/sh\ncase "$*" in */mutex*) exit 1 ;; esac\nexec /bin/mkdir "$@"\n`,
      );
      chmodSync(fake, 0o755);
      const src = readFileSync(script, "utf8").replace("LOCK_WAIT=300", "LOCK_WAIT=2");
      writeFileSync(script, src);
      expect(await run("sh", "-c", "exit 4").exited).toBe(4);
      expect(readFileSync(log, "utf8")).toBe("");
      expect(muted()).toBe(false);
      await until(() => alive().length === 0);
    },
    SLOW,
  );
});

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
      const p = Bun.spawn(["bash", script, "sleep", "30"], {
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
    const p = Bun.spawn(["bash", script, "echo", "hi"], {
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
