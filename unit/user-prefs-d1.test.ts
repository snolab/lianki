import { beforeEach, describe, expect, it } from "bun:test";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import type { D1Like } from "@/lib/d1/types";
import { MAX_CLOCK_AHEAD_MS, MAX_ROWS } from "@/lib/prefs/schema";
import { UserPrefsD1Repo } from "@/lib/repos/userPrefsD1";

const SCHEMA = testSchema();
let d1: TestD1Database;
let clock = 1_000_000;
const repo = (user = "u1") => new UserPrefsD1Repo(d1 as unknown as D1Like, user, () => clock);
const hlc = (timestamp: number, counter = 0, deviceId = "phone0001") => ({
  timestamp,
  counter,
  deviceId,
});

beforeEach(() => {
  d1 = createTestD1(SCHEMA);
  clock = 1_000_000;
  for (const id of ["u1", "u2"])
    d1.raw()
      .prepare(
        "INSERT INTO user (id, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, 1, '2026-10-31', '2026-10-31')",
      )
      .run(id, `${id}@example.com`);
});

describe("UserPrefsD1Repo", () => {
  it("stores a value and reads it back with its clock", async () => {
    const r = await repo().write([{ key: "motion.animations", value: "off", hlc: hlc(900_000) }]);
    expect(r.rejected).toEqual([]);
    expect(r.prefs["motion.animations"]).toEqual({ value: "off", hlc: hlc(900_000) });
    const read = await repo().read();
    expect(read.prefs["motion.animations"].value).toBe("off");
    expect(read.cursor).toBe(clock);
  });

  it("last write wins per field, by HLC, whatever the arrival order", async () => {
    await repo().write([{ key: "words.showAll", value: true, hlc: hlc(900_002) }]);
    const late = await repo().write([{ key: "words.showAll", value: false, hlc: hlc(900_001) }]);
    expect(late.prefs["words.showAll"].value).toBe(true); // the older write lost, the winner comes back
    await repo().write([{ key: "words.showAll", value: false, hlc: hlc(900_002, 1) }]);
    expect((await repo().read()).prefs["words.showAll"].value).toBe(false);
    // a tie on time and counter: the device id decides, the same everywhere
    await repo().write([{ key: "words.showAll", value: true, hlc: hlc(900_002, 1, "phone0000") }]);
    expect((await repo().read()).prefs["words.showAll"].value).toBe(false);
    await repo().write([{ key: "words.showAll", value: true, hlc: hlc(900_002, 1, "phone0002") }]);
    expect((await repo().read()).prefs["words.showAll"].value).toBe(true);
  });

  it("fields are independent", async () => {
    await repo().write([{ key: "words.showAll", value: true, hlc: hlc(900_005) }]);
    await repo().write([{ key: "chat-voice.rate", value: 2, hlc: hlc(900_001, 0, "mac00001") }]);
    const { prefs } = await repo().read();
    expect(prefs["words.showAll"].value).toBe(true);
    expect(prefs["chat-voice.rate"].value).toBe(2);
  });

  it("refuses unknown keys and junk values, and stores nothing for them", async () => {
    const r = await repo().write([
      { key: "debug.localStt", value: "https://mac.ts.net/stt", hlc: hlc(1) },
      { key: "words.showAll", value: "yes", hlc: hlc(1) },
      { key: "ui.paper", value: "c", hlc: hlc(1) },
    ]);
    expect(r.rejected).toEqual(["debug.localStt", "words.showAll"]);
    expect(Object.keys((await repo().read()).prefs)).toEqual(["ui.paper"]);
  });

  it("clamps a clock far ahead of the server's", async () => {
    await repo().write([{ key: "ui.paper", value: "c", hlc: hlc(clock + MAX_CLOCK_AHEAD_MS + 1) }]);
    expect((await repo().read()).prefs["ui.paper"].hlc.timestamp).toBe(clock);
    // a little ahead is kept as is
    await repo().write([{ key: "ui.paper", value: "e", hlc: hlc(clock + 1000) }]);
    expect((await repo().read()).prefs["ui.paper"].hlc.timestamp).toBe(clock + 1000);
  });

  it("since: only rows written at or after the cursor (with a small overlap)", async () => {
    await repo().write([{ key: "ui.paper", value: "c", hlc: hlc(1) }]);
    const { cursor } = await repo().read();
    clock += 60_000;
    await repo().write([{ key: "words.showAll", value: true, hlc: hlc(2) }]);
    const since = await repo().read(cursor + 10_000);
    expect(Object.keys(since.prefs)).toEqual(["words.showAll"]);
    expect(since.cursor).toBe(clock);
  });

  it("accounts never see each other's rows", async () => {
    await repo("u1").write([{ key: "ui.paper", value: "c", hlc: hlc(1) }]);
    expect((await repo("u2").read()).prefs).toEqual({});
  });

  it("caps the rows per account", async () => {
    for (let i = 0; i < MAX_ROWS; i++)
      await d1.exec(
        `INSERT INTO user_prefs VALUES ('u1', 'old.${i}', 'true', 1, 0, 'phone0001', 1)`,
      );
    const r = await repo().write([{ key: "ui.paper", value: "c", hlc: hlc(2) }]);
    expect(r.rejected).toEqual(["ui.paper"]);
    // reads leave out keys that are no longer in the registry
    expect((await repo().read()).prefs).toEqual({});
  });

  it("deleting the user deletes the rows", async () => {
    d1.raw().exec("PRAGMA foreign_keys = ON");
    await repo().write([{ key: "ui.paper", value: "c", hlc: hlc(1) }]);
    d1.raw().prepare("DELETE FROM user WHERE id = ?").run("u1");
    const n = d1.raw().prepare("SELECT COUNT(*) AS n FROM user_prefs").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("exports values without clocks", async () => {
    await repo().write([{ key: "chat-voice.out", value: "cloud", hlc: hlc(1) }]);
    expect(await repo().exportValues()).toEqual({ "chat-voice.out": "cloud" });
  });
});
