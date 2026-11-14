// scripts/dev/preview-follow.ts (docs/dev-whole-page.md, "Following main"):
// event parsing, the catch-up flow against a REAL git in a temp folder (with
// fake resolver / publish / say / typecheck), and the one-run queue. Nothing
// here posts to the owner's chat or touches tree/preview.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FollowQueue,
  type Ran,
  type Runner,
  followOnce,
  mergeTreeConflicts,
  newErrors,
  parseKick,
  parseVersionMessage,
  resolverPrompt,
  typeErrors,
} from "../scripts/dev/preview-follow-lib";

describe("preview-follow: events", () => {
  it("takes a build id from the version socket, nothing else", () => {
    expect(parseVersionMessage('{"build":"abc-123"}')).toBe("abc-123");
    expect(parseVersionMessage('{"build":"x","shell":true,"routes":{}}')).toBe("x");
    expect(parseVersionMessage('{"build":""}')).toBeNull();
    expect(parseVersionMessage('{"build":"a b"}')).toBeNull();
    expect(parseVersionMessage('{"build":7}')).toBeNull();
    expect(parseVersionMessage("not json")).toBeNull();
    expect(parseVersionMessage(new ArrayBuffer(3))).toBeNull();
    expect(parseVersionMessage(`{"build":"${"a".repeat(5000)}"}`)).toBeNull();
  });

  it("reads the hook's kick, dropping a sha that is not hex", () => {
    expect(parseKick("/kick?sha=0123abcd")).toEqual({ sha: "0123abcd" });
    expect(parseKick("/kick?sha=;rm -rf")).toEqual({ sha: null });
    expect(parseKick("/kick")).toEqual({ sha: null });
  });
});

describe("preview-follow: parsing", () => {
  it("lists merge-tree's conflicted paths once each", () => {
    expect(mergeTreeConflicts("tree\na.ts\na.ts\nb.md\n")).toEqual(["a.ts", "b.md"]);
    expect(mergeTreeConflicts("tree\n")).toEqual([]);
  });

  it("compares type errors without positions, ignoring .next/", () => {
    const before = typeErrors("lib/a.ts(3,7): error TS2322: no\n.next/x.ts(1,1): error TS1: gen");
    const after = typeErrors(
      "lib/a.ts(9,7): error TS2322: no\nlib/b.ts(1,1): error TS2304: Cannot find name 'x'.\n.next/y.ts(1,1): error TS1: gen",
    );
    expect(newErrors(before, after)).toEqual(["lib/b.ts: error TS2304: Cannot find name 'x'."]);
  });

  it("tells the resolver to keep both sides and touch only the conflicts", () => {
    const p = resolverPrompt(["lib/a.ts"], "f".repeat(40), "preview/live2");
    expect(p).toContain("- lib/a.ts");
    expect(p).toContain("BOTH sides");
    expect(p).toContain("Never drop a feature");
    expect(p).toContain("Do not run git add, commit");
  });
});

// A real repo: "origin" (bare) with main, and a clone on preview/live2.
let root = "";
// Without GIT_* from the caller: under the pre-push hook GIT_DIR points at
// the real repo, and these temp-repo commands would land there.
const env = {
  ...(Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  ) as NodeJS.ProcessEnv),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const work = () => join(root, "work");
const up = () => join(root, "up");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "preview-follow-"));
  sh(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  sh(root, "clone", "-q", join(root, "origin.git"), "up");
  writeFileSync(join(up(), "a.ts"), "export const a = 1;\n");
  writeFileSync(join(up(), "b.ts"), "export const b = 1;\n");
  sh(up(), "add", ".");
  sh(up(), "commit", "-qm", "base");
  sh(up(), "push", "-q", "origin", "main");
  sh(root, "clone", "-q", join(root, "origin.git"), "work");
  sh(work(), "checkout", "-qb", "preview/live2");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function commitUp(file: string, text: string) {
  writeFileSync(join(up(), file), text);
  sh(up(), "commit", "-qam", `up ${file}`);
  sh(up(), "push", "-q", "origin", "main");
}
function commitWork(file: string, text: string) {
  writeFileSync(join(work(), file), text);
  sh(work(), "commit", "-qam", `work ${file}`);
}

type Calls = { publish: number; say: string[]; resolve: string[][]; typecheck: number };
function deps(
  resolve: (files: string[]) => boolean,
  typecheckOut: () => string = () => "",
): { calls: Calls; d: Parameters<typeof followOnce>[0] } {
  const calls: Calls = { publish: 0, say: [], resolve: [], typecheck: 0 };
  const run: Runner = async (cmd) => {
    if (cmd[0] === "bun") {
      if (cmd[2] === "typecheck") calls.typecheck++;
      return { code: 0, stdout: cmd[2] === "typecheck" ? typecheckOut() : "", stderr: "" };
    }
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: work(), env, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr } satisfies Ran;
  };
  return {
    calls,
    d: {
      run,
      branch: "preview/live2",
      resolve: async (files) => {
        calls.resolve.push(files);
        return resolve(files);
      },
      publish: async () => void calls.publish++,
      say: async (line) => void calls.say.push(line),
    },
  };
}

describe("preview-follow: the catch-up flow (real git, fake agent)", () => {
  it("does nothing when main has not moved", async () => {
    const { calls, d } = deps(() => true);
    expect((await followOnce(d)).kind).toBe("up-to-date");
    expect(calls.publish).toBe(0);
  });

  it("clean merge → merged and published, no resolver", async () => {
    commitUp("a.ts", "export const a = 2;\n");
    commitWork("b.ts", "export const b = 2;\n");
    const { calls, d } = deps(() => true);
    const o = await followOnce(d);
    expect(o.kind).toBe("merged");
    expect(calls).toMatchObject({ publish: 1, say: [], resolve: [] });
    expect(readFileSync(join(work(), "a.ts"), "utf8")).toContain("a = 2");
    expect(sh(work(), "rev-parse", "--abbrev-ref", "HEAD")).toBe("preview/live2");
  });

  it("conflict → resolver → committed and published", async () => {
    commitUp("a.ts", "export const a = 2;\n");
    commitWork("a.ts", "export const a = 3;\n");
    const { calls, d } = deps((files) => {
      for (const f of files) writeFileSync(join(work(), f), "export const a = 2 + 3;\n");
      return true;
    });
    const o = await followOnce(d);
    expect(o).toMatchObject({ kind: "resolved", files: ["a.ts"] });
    expect(calls.publish).toBe(1);
    expect(calls.say).toEqual([]);
    expect(calls.typecheck).toBe(2); // baseline + after
    expect(sh(work(), "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(sh(work(), "status", "--porcelain")).toBe("");
  });

  it("resolver gives up → merge aborted, branch unchanged, one chat line naming the file", async () => {
    commitUp("a.ts", "export const a = 2;\n");
    commitWork("a.ts", "export const a = 3;\n");
    const before = sh(work(), "rev-parse", "HEAD");
    const { calls, d } = deps(() => false);
    const o = await followOnce(d);
    expect(o.kind).toBe("resolve-failed");
    expect(sh(work(), "rev-parse", "HEAD")).toBe(before);
    expect(sh(work(), "status", "--porcelain")).toBe("");
    expect(calls.publish).toBe(0);
    expect(calls.say).toHaveLength(1);
    expect(calls.say[0]).toStartWith("【小可】");
    expect(calls.say[0]).toContain("a.ts");
  });

  it("markers left, a stray file edited, or new type errors → aborted", async () => {
    commitUp("a.ts", "export const a = 2;\n");
    commitWork("a.ts", "export const a = 3;\n");
    const before = sh(work(), "rev-parse", "HEAD");

    const markers = deps(() => true); // claims success, leaves the markers
    const m = await followOnce(markers.d);
    expect(m).toMatchObject({ kind: "resolve-failed" });
    expect((m as { reason: string }).reason).toContain("markers");

    const stray = deps(() => {
      writeFileSync(join(work(), "a.ts"), "export const a = 5;\n");
      writeFileSync(join(work(), "b.ts"), "export const b = 9;\n");
      return true;
    });
    expect(await followOnce(stray.d)).toMatchObject({ kind: "resolve-failed" });
    expect(readFileSync(join(work(), "b.ts"), "utf8")).toBe("export const b = 1;\n");

    let n = 0;
    const typed = deps(
      () => {
        writeFileSync(join(work(), "a.ts"), "export const a = 5;\n");
        return true;
      },
      () => (n++ === 0 ? "" : "a.ts(1,1): error TS2322: bad"),
    );
    expect(await followOnce(typed.d)).toMatchObject({ kind: "resolve-failed" });
    expect(sh(work(), "rev-parse", "HEAD")).toBe(before);
    expect(sh(work(), "status", "--porcelain")).toBe("");
  });

  it("a resolver that commits by itself is stepped back with --keep", async () => {
    commitUp("a.ts", "export const a = 2;\n");
    commitWork("a.ts", "export const a = 3;\n");
    const before = sh(work(), "rev-parse", "HEAD");
    const { d } = deps(() => {
      writeFileSync(join(work(), "a.ts"), "export const a = 5;\n");
      sh(work(), "commit", "-qam", "sneaky");
      return true;
    });
    expect(await followOnce(d)).toMatchObject({ kind: "resolve-failed" });
    expect(sh(work(), "rev-parse", "HEAD")).toBe(before);
  });

  it("skips a dirty worktree, another branch, or a merge in progress", async () => {
    commitUp("a.ts", "export const a = 2;\n");
    writeFileSync(join(work(), "b.ts"), "dirty\n");
    expect(await followOnce(deps(() => true).d)).toMatchObject({ kind: "skipped" });
    sh(work(), "checkout", "-q", "b.ts");
    sh(work(), "checkout", "-qb", "other");
    expect(await followOnce(deps(() => true).d)).toMatchObject({ kind: "skipped" });
    expect(sh(work(), "rev-parse", "HEAD")).toBe(sh(work(), "rev-parse", "preview/live2"));
  });
});

describe("preview-follow: the reference-transaction hook", () => {
  const hook = join(import.meta.dir, "..", ".husky", "reference-transaction");
  function fire(state: string, lines: string, sock: string) {
    return spawnSync("sh", ["-e", hook, state], {
      input: lines,
      env: { ...process.env, LIANKI_PREVIEW_FOLLOW_SOCK: sock },
      encoding: "utf8",
    });
  }

  it("kicks the watcher only when a committed transaction moved origin/main, and never fails git", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-sock-"));
    const sock = join(dir, "s.sock");
    const kicks: string[] = [];
    let got: () => void = () => {};
    const server = Bun.serve({
      unix: sock,
      fetch(req) {
        kicks.push(new URL(req.url).search);
        got();
        return new Response(null, { status: 202 });
      },
    });
    try {
      const sha = "a".repeat(40);
      expect(fire("prepared", `0 ${sha} refs/remotes/origin/main\n`, sock).status).toBe(0);
      expect(fire("committed", `0 ${sha} refs/heads/feature\n`, sock).status).toBe(0);
      const arrived = new Promise<void>((r) => (got = r));
      const both = `0 1 refs/heads/x\n0 ${sha} refs/remotes/origin/main\n`;
      expect(fire("committed", both, sock).status).toBe(0);
      await Promise.race([arrived, Bun.sleep(3000)]);
      expect(kicks).toEqual([`?sha=${sha}`]);
      // No watcher: still exit 0, silently.
      const none = fire("committed", `0 ${sha} refs/remotes/origin/main\n`, join(dir, "none"));
      expect(none.status).toBe(0);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("preview-follow: one run at a time", () => {
  it("a burst during a run makes exactly one more run", async () => {
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const q = new FollowQueue(async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (runs === 1) await new Promise<void>((r) => (release = r));
      active--;
    });
    q.kick();
    for (let i = 0; i < 5; i++) q.kick();
    release();
    await q.idle();
    expect(runs).toBe(2);
    expect(maxActive).toBe(1);
    q.kick();
    await q.idle();
    expect(runs).toBe(3);
  });
});
