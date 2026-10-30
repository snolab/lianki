import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { chunkMessages } from "@/lib/dev-eval";
import {
  MAX_BURST,
  Reassembler,
  SHOT_LIB,
  burst,
  parseShotArgs,
  shotPath,
  size,
  stamp,
} from "@/scripts/dev/shot-lib";

describe("shot.ts arguments", () => {
  it("defaults to one shot of every page", () => {
    expect(parseShotArgs([])).toEqual({ burst: 1, every: 1000, noPair: false, help: false });
  });

  it("reads every flag", () => {
    expect(
      parseShotArgs([
        "--target",
        "iPhone",
        "--out",
        "a.png",
        "--burst",
        "3",
        "--every",
        "250",
        "--selector",
        "main > ul",
        "--label",
        "me",
        "--no-pair",
      ]),
    ).toEqual({
      target: "iPhone",
      out: "a.png",
      burst: 3,
      every: 250,
      selector: "main > ul",
      label: "me",
      noPair: true,
      help: false,
    });
    expect(parseShotArgs(["-h"])).toMatchObject({ help: true });
    expect(parseShotArgs(["--help"])).toMatchObject({ help: true });
  });

  it("refuses what it cannot use", () => {
    const err = (a: string[]) => (parseShotArgs(a) as { error?: string }).error;
    expect(err(["--target"])).toBe("--target needs a value");
    expect(err(["--out", "--no-pair"])).toBe("--out needs a value");
    expect(err(["--burst", "0"])).toContain("≥ 1");
    expect(err(["--burst", "2.5"])).toContain("whole number");
    expect(err(["--burst", String(MAX_BURST + 1)])).toContain(`at most ${MAX_BURST}`);
    expect(err(["--burst", "2", "--every", "-1"])).toContain("of ms");
    expect(err(["--every", "100"])).toBe("--every goes with --burst N");
    expect(err(["--png"])).toBe("unknown argument --png");
  });
});

describe("chunk reassembly", () => {
  const fwd = (page: string, m: ReturnType<typeof chunkMessages>[number]) => {
    const { to: _to, ...rest } = m;
    return { ...rest, page };
  };

  it("joins a piece's chunks, in whatever order they come", () => {
    const r = new Reassembler();
    const data = "0123456789".repeat(5);
    const ms = chunkMessages("e", "c", 0, data, 7).map((m) => fwd("/words iPhone", m));
    const shuffled = [ms[3], ms[0], ms[6], ms[1], ms[5], ms[2]];
    for (const m of shuffled) expect(r.add(m)).toBeUndefined();
    expect(r.pending()).toEqual(["/words iPhone#0 (6/8)"]);
    expect(r.add(ms[4])).toBeUndefined();
    expect(r.add(ms[7])).toEqual({ page: "/words iPhone", part: 0, data });
    expect(r.pending()).toEqual([]);
  });

  it("keeps pages and parts apart, and a repeated chunk counts once", () => {
    const r = new Reassembler();
    const a = chunkMessages("e", "c", 0, "aaaa", 2).map((m) => fwd("A", m));
    const b = chunkMessages("e", "c", 0, "bbbb", 2).map((m) => fwd("B", m));
    const a1 = chunkMessages("e", "c", 1, "AAAA", 2).map((m) => fwd("A", m));
    r.add(a[0]);
    r.add(a[0]);
    r.add(b[1]);
    r.add(a1[1]);
    expect(r.pending()).toHaveLength(3);
    expect(r.add(b[0])).toEqual({ page: "B", part: 0, data: "bbbb" });
    expect(r.add(a1[0])).toEqual({ page: "A", part: 1, data: "AAAA" });
    expect(r.add(a[1])).toEqual({ page: "A", part: 0, data: "aaaa" });
  });

  it("refuses a malformed chunk, or one whose total changed", () => {
    const r = new Reassembler();
    const ok = { page: "p", part: 0, seq: 0, total: 2, data: "x" };
    expect(() => r.add({ ...ok, data: 1 })).toThrow("bad chunk");
    expect(() => r.add({ ...ok, seq: 2 })).toThrow("bad chunk");
    expect(() => r.add({ ...ok, seq: -1 })).toThrow("bad chunk");
    expect(() => r.add({ ...ok, total: 0 })).toThrow("bad chunk");
    expect(() => r.add({ ...ok, part: "0" })).toThrow("bad chunk");
    r.add(ok);
    expect(() => r.add({ ...ok, seq: 1, total: 3 })).toThrow("total changed");
    // No page label still works (an empty one).
    expect(new Reassembler().add({ part: 0, seq: 0, total: 1, data: "z" })).toEqual({
      page: "",
      part: 0,
      data: "z",
    });
  });
});

describe("where shots go", () => {
  const d = { dir: "/r/.shots", stamp: "20261030-142501" };

  it("names them by time in the default folder, or one given", () => {
    expect(shotPath(d, 0, 1, 0)).toBe(join("/r/.shots", "20261030-142501.png"));
    expect(shotPath({ ...d, out: "/tmp/x", isDir: true }, 0, 1, 0)).toBe(
      join("/tmp/x", "20261030-142501.png"),
    );
    expect(shotPath({ ...d, out: "shots" }, 1, 3, 1)).toBe(
      join("shots", "20261030-142501-2-p2.png"),
    );
  });

  it("uses a .png path as is, numbering a burst and later pages", () => {
    expect(shotPath({ ...d, out: "a/b.png" }, 0, 1, 0)).toBe("a/b.png");
    expect(shotPath({ ...d, out: "a/b.PNG" }, 2, 3, 0)).toBe("a/b-3.png");
    expect(shotPath({ ...d, out: "a/b.png" }, 0, 1, 1)).toBe("a/b-p2.png");
  });

  it("stamps local time, zero-padded", () => {
    expect(stamp(new Date(2026, 0, 2, 3, 4, 5))).toBe("20260102-030405");
  });

  it("prints sizes", () => {
    expect(size(2_600_000)).toBe("2.6 MB");
    expect(size(71_400)).toBe("71 KB");
  });

  it("pins the screenshot library to an exact version", () => {
    expect(SHOT_LIB).toMatch(/modern-screenshot@\d+\.\d+\.\d+\//);
  });
});

/** A clock that only moves when the code sleeps or a shot takes time. */
function fakeClock() {
  let t = 1000;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => (t += ms),
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe("burst timer", () => {
  it("takes n shots every ms apart, by the page's own clock", async () => {
    const c = fakeClock();
    const taken: number[] = [];
    const shots = await burst(
      3,
      500,
      async () => {
        taken.push(c.now());
        c.advance(100);
      },
      c,
    );
    expect(taken).toEqual([1000, 1500, 2000]);
    expect(shots).toEqual([
      { i: 0, at: 0 },
      { i: 1, at: 500 },
      { i: 2, at: 1000 },
    ]);
    expect(c.sleeps).toEqual([400, 400]);
  });

  it("a slow shot pushes the next one back, never overlapping it", async () => {
    const c = fakeClock();
    const shots = await burst(3, 200, async (i) => void c.advance(i === 0 ? 450 : 50), c);
    expect(shots.map((s) => s.at)).toEqual([0, 450, 500]);
    expect(c.sleeps).toEqual([]);
  });

  it("records a failed shot and goes on", async () => {
    const c = fakeClock();
    const shots = await burst(
      3,
      0,
      async (i) => {
        if (i === 1) throw new TypeError("canvas tainted");
        if (i === 2) throw "plain";
      },
      c,
    );
    expect(shots).toEqual([
      { i: 0, at: 0 },
      { i: 1, at: 0, error: "TypeError: canvas tainted" },
      { i: 2, at: 0, error: "plain" },
    ]);
  });

  it("runs from its own source, as shot.ts sends it to the page", async () => {
    const fromSource = new Function(`return (${burst.toString()})`)() as typeof burst;
    const c = fakeClock();
    const shots = await fromSource(2, 100, async () => {}, c);
    expect(shots).toEqual([
      { i: 0, at: 0 },
      { i: 1, at: 100 },
    ]);
  });
});
