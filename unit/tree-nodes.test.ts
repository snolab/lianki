import { beforeEach, describe, expect, test } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { PreferencesD1Repo } from "@/lib/repos/d1Repos";
import { NodesD1Repo, TreeError } from "@/lib/repos/nodesD1";

const SCHEMA = testSchema();
let d1: TestD1Database;
let repo: NodesD1Repo;

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  const now = new Date().toISOString();
  for (const id of ["u1", "u2", "u3"])
    d1.raw()
      .prepare(`INSERT INTO user (id, email, createdAt, updatedAt) VALUES (?, ?, ?, ?)`)
      .run(id, `${id}@example.com`, now, now);
  repo = new NodesD1Repo(d1, "u1", "Asia/Tokyo");
});

const by = "agent:partner";
const events = () =>
  d1
    .raw()
    .prepare(`SELECT seq, node_id, type, ancestors, old_ancestors FROM node_events ORDER BY seq`)
    .all() as {
    seq: number;
    node_id: string;
    type: string;
    ancestors: string;
    old_ancestors: string | null;
  }[];

async function seed() {
  await repo.apply(
    [
      { op: "create", id: "plan", parent: null, slug: "plan", title: "Study plan", tags: ["plan"] },
      {
        op: "create",
        id: "goal",
        parent: "plan",
        slug: "n3",
        title: "JLPT N3",
        tags: ["Goal"],
        fields: { targetDate: "2027-07-04", mood: "keen" },
      },
      {
        op: "create",
        id: "habit",
        parent: "goal",
        title: "Daily words",
        tags: ["habit"],
        fields: { minutesPerDay: "lots", newPerDay: 10 },
      },
      {
        op: "create",
        id: "s1",
        parent: "habit",
        title: "Morning words",
        tags: ["session"],
        time: { start: "2026-11-02T22:00:00Z", end: "2026-11-02T22:30:00Z", rrule: "FREQ=DAILY" },
      },
    ],
    { summary: "Set up N3", by },
  );
}

describe("node tree", () => {
  test("generic nodes: tags normalised, known fields checked softly, unknown kept", async () => {
    await seed();
    const goal = await repo.get("goal");
    expect(goal?.tags).toEqual(["goal"]);
    expect(goal?.fields).toEqual({ targetDate: "2027-07-04", mood: "keen" });
    // A known key with the wrong type is dropped; the rest stays.
    expect((await repo.get("habit"))?.fields).toEqual({ newPerDay: 10 });
    const s1 = await repo.get("s1");
    expect(s1?.time).toEqual({
      start: "2026-11-02T22:00:00.000Z",
      end: "2026-11-02T22:30:00.000Z",
      tz: "Asia/Tokyo",
      rrule: "FREQ=DAILY",
      originalStart: null,
    });
  });

  test("subtree by depth, roots, and paths", async () => {
    await seed();
    expect((await repo.subtree("plan", 0)).map((n) => n.id)).toEqual(["plan"]);
    expect((await repo.subtree("plan", 1)).map((n) => n.id)).toEqual(["plan", "goal"]);
    expect((await repo.subtree("plan", -1)).map((n) => [n.id, n.depth])).toEqual([
      ["plan", 0],
      ["goal", 1],
      ["habit", 2],
      ["s1", 3],
    ]);
    expect((await repo.subtree(null, 0)).map((n) => n.id)).toEqual(["plan"]);
    expect((await repo.resolvePath("/plan/n3"))?.id).toBe("goal");
    expect(await repo.resolvePath("/plan/nope")).toBeNull();
    // Another user sees nothing.
    expect(await new NodesD1Repo(d1, "u2").subtree(null, -1)).toEqual([]);
  });

  test("timed nodes in a range (series included)", async () => {
    await seed();
    const hits = await repo.timed("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z");
    expect(hits.map((n) => n.id)).toEqual(["s1"]);
  });

  test("events carry ancestor chains; a move carries both", async () => {
    await seed();
    await repo.apply([{ op: "move", id: "habit", parent: "plan" }], { summary: "Move", by });
    const ev = events();
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.parse(ev[3].ancestors)).toEqual(["plan", "goal", "habit"]);
    expect(ev[4].type).toBe("moved");
    expect(JSON.parse(ev[4].ancestors)).toEqual(["plan"]);
    expect(JSON.parse(ev[4].old_ancestors as string)).toEqual(["plan", "goal"]);
  });

  test("direct apply, then undo, then undo the undo", async () => {
    await seed();
    const cs = await repo.apply(
      [
        {
          op: "update",
          id: "s1",
          title: "Early words",
          time: { start: "2026-11-02T21:30:00Z", end: "2026-11-02T22:00:00Z" },
        },
        { op: "update", id: "s1", status: "done" },
        { op: "delete", id: "goal" },
      ],
      { summary: "Rebalance", by },
    );
    expect(await repo.get("goal")).toBeNull();
    expect(await repo.get("s1")).toBeNull(); // deleted with its subtree
    const undo = await repo.undo(cs.id, "user");
    const s1 = await repo.get("s1");
    expect(s1?.title).toBe("Morning words");
    expect(s1?.status).toBeNull();
    expect(s1?.time?.start).toBe("2026-11-02T22:00:00.000Z");
    expect((await repo.changesets()).map((c) => [c.summary, c.status])).toEqual([
      ["Undo: Rebalance", "applied"],
      ["Rebalance", "undone"],
      ["Set up N3", "applied"],
    ]);
    await expect(repo.undo(cs.id, "user")).rejects.toThrow("already undone");
    // Undoing the undo re-applies the rebalance: the goal (and s1 with it) goes again.
    await repo.undo(undo.id, "user");
    expect(await repo.get("goal")).toBeNull();
    const raw = d1.raw().prepare(`SELECT title, deleted_at FROM nodes WHERE id = 's1'`).get() as {
      title: string;
      deleted_at: string | null;
    };
    expect(raw.title).toBe("Early words");
    expect(raw.deleted_at).not.toBeNull();
  });

  test("a restore brings back only what that delete took", async () => {
    await seed();
    await repo.apply([{ op: "delete", id: "s1" }], { summary: "Drop session", by });
    const cs = await repo.apply([{ op: "delete", id: "goal" }], { summary: "Drop goal", by });
    await repo.undo(cs.id, "user");
    expect((await repo.get("habit"))?.title).toBe("Daily words");
    expect(await repo.get("s1")).toBeNull();
  });

  test("rejects bad ops; nothing half-applied", async () => {
    await seed();
    const bad = (ops: Parameters<NodesD1Repo["apply"]>[0]) => repo.apply(ops, { summary: "x", by });
    await expect(bad([{ op: "move", id: "plan", parent: "s1" }])).rejects.toThrow("under itself");
    await expect(bad([{ op: "update", id: "goal", ifVersion: 9 }])).rejects.toThrow("changed");
    await expect(bad([{ op: "update", id: "goal", status: "maybe" as never }])).rejects.toThrow(
      "bad status",
    );
    await expect(
      bad([
        {
          op: "create",
          parent: "plan",
          title: "t",
          time: { start: "2026-11-02T10:00:00Z", end: "2026-11-02T09:00:00Z" },
        },
      ]),
    ).rejects.toThrow("end must be after start");
    await expect(bad([{ op: "update", id: "missing", title: "x" }])).rejects.toBeInstanceOf(
      TreeError,
    );
    // The first op is valid, the second is not: neither lands.
    await expect(
      bad([
        { op: "update", id: "goal", title: "Renamed" },
        { op: "update", id: "nope", title: "x" },
      ]),
    ).rejects.toThrow();
    expect((await repo.get("goal"))?.title).toBe("JLPT N3");
    await expect(
      repo.apply([{ op: "update", id: "goal", title: "x" }], { summary: " ", by }),
    ).rejects.toThrow("summary");
  });

  test("an unknown zone makes time facets UTC", async () => {
    const utc = new NodesD1Repo(d1, "u3");
    await utc.apply(
      [
        {
          op: "create",
          id: "t",
          parent: null,
          title: "Block",
          time: { start: "2026-11-02T09:00:00Z", end: "2026-11-02T10:00:00Z" },
        },
      ],
      { summary: "Block", by: "user" },
    );
    expect((await utc.get("t"))?.time?.tz).toBe("UTC");
  });

  test("the plan root is made once", async () => {
    const a = await repo.ensurePlanRoot("zh");
    const b = await repo.ensurePlanRoot("en");
    expect(a.id).toBe(b.id);
    expect(a.title).toBe("学习计划");
    expect(a.tags).toEqual(["plan"]);
    expect(await repo.changesets()).toEqual([]);
  });

  test("time zone preference", async () => {
    const prefs = new PreferencesD1Repo(d1, "u1");
    expect(await prefs.timeZone()).toBeNull();
    await prefs.set([], "newest");
    await prefs.setTimeZone("Europe/Berlin");
    expect(await prefs.timeZone()).toBe("Europe/Berlin");
    expect(await prefs.reviewOrder()).toBe("newest");
    await prefs.set([]);
    expect(await prefs.timeZone()).toBe("Europe/Berlin");
  });
});
