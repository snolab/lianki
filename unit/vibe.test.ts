// /vibe (docs/vibe.md): the gate, the start tap, pause, keeping, account isolation,
// and ambient text never leaving for anything but its own transcript. Every line
// here is invented text. No microphone, no audio: a fake VAD drives the real mic
// core, and a fake Mac answers.
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createTestD1, type TestD1Database } from "@/lib/d1/testDb";
import { testSchema } from "@/lib/d1/testSchema";
import { FLAGS } from "@/lib/flags";
import type { D1Batch } from "@/lib/read/reader-store";
import { polishActionShown, offerShown, polishRefused } from "@/lib/read/polish-offer";
import { parseBookMeta, type BookMeta } from "@/lib/read/book";
import {
  linesReply,
  settingsGetReply,
  settingsPutReply,
  startReply,
  stateReply,
  vibeUserId,
} from "@/lib/vibe/api";
import { checkRetention, vibeAllowed } from "@/lib/vibe/gate";
import { sweepVibeDocs } from "@/lib/vibe/retention";
import {
  createVibeSession,
  vibeRoute,
  type VibeDeps,
  type VibeStt,
  type VibeView,
} from "@/lib/vibe/session";
import { getDocLog, getRetentionDays, listDocs, setRetentionDays } from "@/lib/vibe/store";
import { createMicTaps, micTaps } from "@lianki/debug-chat/mic-taps";
import { createMicSession } from "@lianki/debug-chat/mic-session";
import type { LocalState } from "@lianki/debug-chat/local-stt";
import { pageScene, screenText } from "@lianki/debug-chat/scene";
import { useBackend, useBlobs, useD1 } from "./support/testMocks";

const { getReadMaterialById, listReadMaterials, deleteReadMaterial, findReadMaterialIdByHash } =
  await import("@/lib/getReadMaterialsCollection");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const DAY = 86_400_000;
const T0 = 1_800_000_000_000;

let d1: TestD1Database;
let db: D1Batch;
const blobStore = new Map<string, string>();

beforeEach(() => {
  d1 = createTestD1(testSchema());
  db = d1 as unknown as D1Batch;
  useD1(d1);
  useBackend("d1");
  for (const u of ["u1", "u2", "u3"])
    d1.exec(
      `INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES ('${u}', '${u}@example.com', '${u}', 1, 0, 0)`,
    );
  blobStore.clear();
  useBlobs({
    put: async (k: string, v: string) => void blobStore.set(k, v),
    get: async (k: string) => (blobStore.has(k) ? { text: async () => blobStore.get(k)! } : null),
    delete: async (k: string) => void blobStore.delete(k),
  });
});

const start = async (user = "u1") => {
  const r = await startReply(db, user, { tap: true, title: "Conversation" }, T0);
  expect(r.status).toBe(200);
  return r.body.id as string;
};

describe("the gate", () => {
  it("is default off and registered", () => {
    expect(FLAGS["read.vibe"].default).toBe(false);
  });

  it("flag off: nobody gets in, the owner included", () => {
    const owner = { userId: "o", owner: true };
    expect(vibeAllowed({}, true)).toBe(false);
    expect(vibeAllowed(null, true)).toBe(false);
    expect(vibeUserId(owner, {}, "d1")).toBeNull();
    expect(vibeUserId(owner, { "read.vibe": false }, "d1")).toBeNull();
    expect(vibeUserId(owner, null, "d1")).toBeNull();
  });

  it("flag on: only the owner, only on D1, only signed in", () => {
    const flags = { "read.vibe": true };
    expect(vibeUserId({ userId: "o", owner: true }, flags, "d1")).toBe("o");
    expect(vibeUserId({ userId: "u", owner: false }, flags, "d1")).toBeNull();
    expect(vibeUserId(null, flags, "d1")).toBeNull();
    expect(vibeUserId({ userId: "o", owner: true }, flags, "mongodb")).toBeNull();
  });

  it("every /api/vibe route goes through the gate", () => {
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f === "route.ts") routes.push(p);
      }
    };
    walk("app/api/vibe");
    expect(routes.length).toBe(5);
    for (const r of routes) expect(readFileSync(r, "utf8")).toMatch(/vibeWrite|vibeGate/);
    const gate = readFileSync("lib/vibe/route.ts", "utf8");
    expect(gate).toContain("vibeUserId(");
    expect(gate).toContain("readFlags()");
  });

  it("the page is gated on the server too, with no owner bypass", () => {
    const gate = readFileSync("lib/vibe/page-gate.ts", "utf8");
    expect(gate).toContain("vibeAllowed(await readFlags()");
    expect(gate).toContain("notFound()");
    for (const p of ["page.tsx", "new/page.tsx", "[id]/page.tsx"]) {
      const page = readFileSync(`app/(app)/vibe/${p}`, "utf8");
      expect(page).toContain("await vibePage()");
      expect(page).toContain('dynamic = "force-dynamic"');
    }
    const log = readFileSync("app/(app)/vibe/[id]/page.tsx", "utf8");
    expect(log).toContain("if (!log) notFound();");
  });

  it("mic starts only from the start button, by a real tap", () => {
    const client = readFileSync("app/(app)/vibe/VibeClient.tsx", "utf8");
    expect(client).toContain("e.isTrusted");
    // No effect, query or route can start one: `.start(` appears once, inside the tap's handler.
    expect(client.match(/\.start\(/g)?.length).toBe(1);
    expect(client).not.toContain("useSearchParams");
  });
});

describe("starting", () => {
  it("the server opens nothing without the tap", async () => {
    for (const body of [{}, { tap: false }, { tap: "true" }, { tap: 1 }, { consent: true }, null]) {
      const r = await startReply(db, "u1", { title: "x", ...body }, T0);
      expect(r).toEqual({ status: 400, body: { error: "tap-required" } });
    }
    const { results } = await db.prepare("SELECT id FROM vibe_doc").bind().all();
    expect(results).toEqual([]);
  });

  it("the tap alone starts: no language, no statement to accept", async () => {
    const id = await start();
    const row = await db
      .prepare("SELECT status, started_ms FROM vibe_doc WHERE id = ?")
      .bind(id)
      .first<{ status: string; started_ms: number }>();
    expect(row).toEqual({ status: "running", started_ms: T0 });
  });

  it("the page is a simple one: no form, no dialog, the tap's trust check kept", () => {
    const client = readFileSync("app/(app)/vibe/VibeClient.tsx", "utf8");
    for (const gone of ['role="dialog"', "<select", "vibe-consent", "vibe-cancel", "ConsentScreen"])
      expect(client).not.toContain(gone);
    expect(client).toContain("if (e.isTrusted) onStart();");
    expect(existsSync("app/(app)/vibe/vibe-consent.content.ts")).toBe(false);
  });

  it("the line to the user is on the start page, in every locale, and asks for nothing", async () => {
    const page = (await import("@/app/(app)/vibe/page.content")).default;
    const locales = (await import("@/lib/constants")).BLOG_LOCALES;
    const leaf = (k: string) =>
      (page.content as unknown as Record<string, { translation: Record<string, string> }>)[k]
        .translation;
    for (const k of ["yourCare", "intro", "recognised", "retentionOff"])
      for (const l of locales) expect(leaf(k)[l]?.length).toBeGreaterThan(0);
    const client = readFileSync("app/(app)/vibe/VibeClient.tsx", "utf8");
    expect(client).toContain("{t.yourCare}");
    // Text, not a control: nothing to dismiss before Start.
    expect(client).toMatch(/<p[^>]*data-testid="vibe-care"[^>]*>\s*\{t\.yourCare\}\s*<\/p>/);
  });

  it("no fixed retention, and no legal wording, anywhere in its text", async () => {
    const page = (await import("@/app/(app)/vibe/page.content")).default;
    const text = JSON.stringify(page.content);
    expect(text).not.toMatch(/\{days\}|30 days|30 天|30天|\bconsent\b/i);
    expect(readFileSync("lib/flags.ts", "utf8")).not.toContain("30 天");
    expect(readFileSync("docs/vibe.md", "utf8")).not.toMatch(/30 days by default|默认 30/);
    expect(readFileSync("app/(app)/vibe/VibeRetention.tsx", "utf8")).not.toMatch(/\b30\b/);
  });
});

describe("the transcript", () => {
  it("appends, in order, as a private material of source vibe", async () => {
    const id = await start();
    const a = await linesReply(
      db,
      "u1",
      id,
      { from: 0, lines: ["Bonjour, je m'appelle Léa et je suis ici."] },
      T0 + 1,
    );
    expect(a.status).toBe(200);
    const material = a.body.material as string;
    await linesReply(db, "u1", id, { from: 1, lines: ["今天天气很好，我们去公园吧。"] }, T0 + 2);
    const m = await getReadMaterialById("u1", material);
    expect(m!.lines).toEqual([
      "Bonjour, je m'appelle Léa et je suis ici.",
      "今天天气很好，我们去公园吧。",
    ]);
    const meta = parseBookMeta(m!.content ?? "") as BookMeta;
    expect(meta.source).toBe("vibe");
    expect(meta.shape?.raw).toBe(false);
    expect(meta.langs?.map(([, l]) => l)).toContain("zh");
  });

  it("a retry cannot add a line twice, and a gap is refused", async () => {
    const id = await start();
    await linesReply(db, "u1", id, { from: 0, lines: ["one line", "two lines"] }, T0);
    const r = await linesReply(db, "u1", id, { from: 1, lines: ["two lines", "three lines"] }, T0);
    expect(r.body.next).toBe(3);
    const gap = await linesReply(db, "u1", id, { from: 9, lines: ["x"] }, T0);
    expect(gap.status).toBe(409);
    const m = await getReadMaterialById("u1", r.body.material as string);
    expect(m!.lines).toEqual(["one line", "two lines", "three lines"]);
  });

  it("a start with nothing said leaves nothing in /read", async () => {
    const id = await start();
    await stateReply(db, "u1", id, { state: "stopped" });
    expect((await listReadMaterials("u1")).materials).toEqual([]);
    expect(await db.prepare("SELECT id FROM vibe_doc").bind().first()).toBeNull();
  });

  it("paused and stopped refuse writes; a tap's running opens them, nothing else does", async () => {
    const id = await start();
    await linesReply(db, "u1", id, { from: 0, lines: ["before the pause"] }, T0);
    expect((await stateReply(db, "u1", id, { state: "paused" })).status).toBe(200);
    expect((await linesReply(db, "u1", id, { from: 1, lines: ["during"] }, T0)).status).toBe(409);
    await stateReply(db, "u1", id, { state: "running" });
    const ok = await linesReply(db, "u1", id, { from: 1, lines: ["after"] }, T0);
    expect(ok.status).toBe(200);
    await stateReply(db, "u1", id, { state: "stopped" });
    expect((await linesReply(db, "u1", id, { from: 2, lines: ["late"] }, T0)).status).toBe(409);
    // A late pause from an old page does not reopen it.
    expect((await stateReply(db, "u1", id, { state: "paused" })).status).toBe(409);
    expect((await linesReply(db, "u1", id, { from: 2, lines: ["late"] }, T0)).status).toBe(409);
    const m = await getReadMaterialById("u1", ok.body.material as string);
    expect(m!.lines).toEqual(["before the pause", "after"]);
    // Keep going on the log page: more of the same conversation.
    expect((await stateReply(db, "u1", id, { state: "running" })).status).toBe(200);
    expect((await linesReply(db, "u1", id, { from: 2, lines: ["more"] }, T0)).status).toBe(200);
    expect((await getReadMaterialById("u1", ok.body.material as string))!.lines).toEqual([
      "before the pause",
      "after",
      "more",
    ]);
  });

  it("reopening one conversation closes any other: one writer at a time", async () => {
    const a = await start();
    await linesReply(db, "u1", a, { from: 0, lines: ["first conversation"] }, T0);
    const b = await start();
    await linesReply(db, "u1", b, { from: 0, lines: ["second conversation"] }, T0);
    await stateReply(db, "u1", a, { state: "running" });
    expect((await linesReply(db, "u1", b, { from: 1, lines: ["late"] }, T0)).status).toBe(409);
    expect((await linesReply(db, "u1", a, { from: 1, lines: ["on"] }, T0)).status).toBe(200);
  });

  it("a new start closes the open conversation", async () => {
    const a = await start();
    await start();
    expect((await linesReply(db, "u1", a, { from: 0, lines: ["x"] }, T0)).status).toBe(409);
  });

  it("a full transcript says so", async () => {
    const id = await start();
    const lines = Array.from({ length: 100 }, () => "word ".repeat(790));
    let status = 200;
    for (let i = 0; i < 8 && status === 200; i++)
      status = (await linesReply(db, "u1", id, { from: i * 100, lines }, T0)).status;
    expect(status).toBe(413);
  });

  it("carries a long transcript at a tolerable cost per line", async () => {
    const id = await start();
    const lines = Array.from(
      { length: 100 },
      (_, i) => `This is invented line number ${i} of a chat.`,
    );
    for (let i = 0; i < 30; i++) await linesReply(db, "u1", id, { from: i * 100, lines }, T0);
    const t = performance.now();
    await linesReply(db, "u1", id, { from: 3000, lines: ["one more"] }, T0);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("the routes' answers", () => {
  it("a malformed body is refused before anything is written", async () => {
    const id = await start();
    for (const body of [
      null,
      7,
      {},
      { from: -1, lines: ["x"] },
      { from: 0.5, lines: ["x"] },
      { from: 0 },
      { from: 0, lines: [] },
    ])
      expect((await linesReply(db, "u1", id, body, T0)).status).toBe(400);
    const many = Array.from({ length: 101 }, () => "x");
    expect((await linesReply(db, "u1", id, { from: 0, lines: many }, T0)).status).toBe(400);
    for (const body of [null, {}, { state: "deleted" }])
      expect((await stateReply(db, "u1", id, body)).status).toBe(400);
    expect((await startReply(db, "u1", { tap: true, title: "   " }, T0)).status).toBe(400);
  });

  it("lines of nothing add nothing, and say how far it has got", async () => {
    const id = await start();
    const r = await linesReply(db, "u1", id, { from: 0, lines: ["  ", "\u0000"] }, T0);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ next: 0, material: null, langs: [] });
    expect(r.appended).toBeUndefined();
    const ok = await linesReply(db, "u1", id, { from: 0, lines: ["a real invented line"] }, T0);
    expect(ok.appended?.material).toBe(ok.body.material as string);
  });

  it("the setting reads back", async () => {
    expect(await settingsGetReply(db, "u1")).toEqual({ status: 200, body: { days: null } });
    await settingsPutReply(db, "u1", { days: 12 }, T0);
    expect(await settingsGetReply(db, "u1")).toEqual({ status: 200, body: { days: 12 } });
    await settingsPutReply(db, "u1", { days: 14 }, T0);
    expect((await settingsGetReply(db, "u1")).body.days).toBe(14);
    expect((await settingsPutReply(db, "u1", null, T0)).status).toBe(400);
    expect((await settingsPutReply(db, "u1", {}, T0)).status).toBe(400);
    expect((await settingsPutReply(db, "u1", { days: null }, T0)).body).toEqual({ days: null });
    expect((await settingsGetReply(db, "u1")).body.days).toBeNull();
  });

  it("stopping twice is fine; a doc whose material was deleted is gone", async () => {
    const id = await start();
    const r = await linesReply(db, "u1", id, { from: 0, lines: ["about to be deleted"] }, T0);
    await stateReply(db, "u1", id, { state: "stopped" });
    expect((await stateReply(db, "u1", id, { state: "stopped" })).status).toBe(200);
    const live = await start();
    await linesReply(db, "u1", live, { from: 0, lines: ["about to be deleted too"] }, T0);
    const m = await db
      .prepare("SELECT material_id FROM vibe_doc WHERE id = ?")
      .bind(live)
      .first<{ material_id: string }>();
    await deleteReadMaterial("u1", m!.material_id);
    expect((await linesReply(db, "u1", live, { from: 1, lines: ["late"] }, T0)).status).toBe(404);
    expect(r.status).toBe(200);
  });
});

describe("the pages", () => {
  it("the list: newest first, with languages and length; a start that heard nothing is not in it", async () => {
    const a = await start();
    await linesReply(db, "u1", a, { from: 0, lines: ["Hello there, how are you?"] }, T0);
    const b = await start();
    await linesReply(
      db,
      "u1",
      b,
      { from: 0, lines: ["你好，很高兴认识你。", "I am well, and you?", "我也很好，谢谢。"] },
      T0 + DAY,
    );
    const empty = await start();
    const rows = await listDocs(db, "u1");
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect(rows.some((r) => r.id === empty)).toBe(false);
    expect(rows[0]).toMatchObject({ lines: 3, lastMs: T0 + DAY, title: "Conversation" });
    expect(rows[0].langs[0]).toBe("zh");
    expect(rows[0].langs).toContain("en");
    expect(await listDocs(db, "u2")).toEqual([]);
    expect(await stateReply(db, "u1", empty, { state: "stopped" })).toMatchObject({ status: 200 });
    expect((await listDocs(db, "u1")).length).toBe(2);
  });

  it("a doc from before the langs column still shows its languages", async () => {
    const a = await start();
    await linesReply(db, "u1", a, { from: 0, lines: ["Hello there, how are you?"] }, T0);
    d1.exec(`UPDATE vibe_doc SET langs = NULL WHERE id = '${a}'`);
    expect((await listDocs(db, "u1"))[0].langs).toEqual(["en"]);
  });

  it("the log: its lines and languages, for its owner only", async () => {
    const a = await start();
    await linesReply(db, "u1", a, { from: 0, lines: ["Hello there, how are you?"] }, T0);
    const log = await getDocLog(db, "u1", a);
    expect(log).toMatchObject({ next: 1, status: "running", text: ["Hello there, how are you?"] });
    expect(log!.lineLangs).toEqual(["en"]);
    expect(await getDocLog(db, "u2", a)).toBeNull();
    expect(await getDocLog(db, "u1", "no-such-doc")).toBeNull();
    const empty = await start();
    expect(await getDocLog(db, "u1", empty)).toBeNull();
  });

  it("ids are random", async () => {
    const a = await start();
    const b = await start();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("a rename survives the next line", async () => {
    const a = await start();
    const r = await linesReply(db, "u1", a, { from: 0, lines: ["first line said"] }, T0);
    const { renameReadMaterial } = await import("@/lib/getReadMaterialsCollection");
    await renameReadMaterial("u1", r.body.material as string, "Coffee with a friend");
    await linesReply(db, "u1", a, { from: 1, lines: ["second line said"] }, T0);
    expect((await listDocs(db, "u1"))[0].title).toBe("Coffee with a friend");
  });

  it("deleting the material takes it off the list and off its address", async () => {
    const a = await start();
    const r = await linesReply(db, "u1", a, { from: 0, lines: ["about to go"] }, T0);
    const { deleteReadMaterial } = await import("@/lib/getReadMaterialsCollection");
    await deleteReadMaterial("u1", r.body.material as string);
    expect(await listDocs(db, "u1")).toEqual([]);
    expect(await getDocLog(db, "u1", a)).toBeNull();
  });
});

describe("account isolation", () => {
  it("another account can neither read nor write it", async () => {
    const id = await start("u1");
    const r = await linesReply(
      db,
      "u1",
      id,
      { from: 0, lines: ["something private and invented"] },
      T0,
    );
    const material = r.body.material as string;
    const hash = (await getReadMaterialById("u1", material))!.contentHash!;

    expect(await getReadMaterialById("u2", material)).toBeNull();
    expect((await listReadMaterials("u2")).materials).toEqual([]);
    expect(await findReadMaterialIdByHash("u2", hash)).toBeNull();
    expect(await deleteReadMaterial("u2", material)).toBe(false);
    expect((await linesReply(db, "u2", id, { from: 1, lines: ["intruder"] }, T0)).status).toBe(404);
    expect((await stateReply(db, "u2", id, { state: "stopped" })).status).toBe(404);

    expect((await getReadMaterialById("u1", material))!.lines).toHaveLength(1);
  });

  it("a material has no public path: /api/read/[id] asks for the signed-in user's own", () => {
    const route = readFileSync("app/api/read/[id]/route.ts", "utf8");
    expect(route).toContain("getReadMaterialById(session.user.id, id)");
    expect(route).toContain("{ status: 401 }");
  });
});

describe("retention", () => {
  const seed = async (user: string, atMs: number, text = "an invented line") => {
    const r0 = await startReply(db, user, { tap: true, title: "T" }, atMs);
    const id = r0.body.id as string;
    const r = await linesReply(db, user, id, { from: 0, lines: [text] }, atMs);
    return { id, material: r.body.material as string };
  };

  /** What #647 could leave behind: a bare row, as the old field saved on blur. */
  const legacyRow = (user: string, days: number) =>
    d1.exec(
      `INSERT INTO vibe_settings (user_id, retention_days, updated_ms) VALUES ('${user}', ${days}, 0)`,
    );

  it("unset means never: the sweep leaves their docs alone, however old", async () => {
    expect(await getRetentionDays(db, "u1")).toBeNull();
    const { material } = await seed("u1", T0);
    expect(await sweepVibeDocs(db, null, T0 + 10_000 * DAY)).toBe(0);
    expect(await getReadMaterialById("u1", material)).not.toBeNull();
  });

  it("a chosen number counts from the newest line", async () => {
    await setRetentionDays(db, "u1", 30, T0);
    const { material } = await seed("u1", T0);
    expect(await sweepVibeDocs(db, null, T0 + 30 * DAY - 1)).toBe(0);
    expect(await getReadMaterialById("u1", material)).not.toBeNull();
    expect(await sweepVibeDocs(db, null, T0 + 30 * DAY)).toBe(1);
    expect(await getReadMaterialById("u1", material)).toBeNull();
    expect(await db.prepare("SELECT id FROM vibe_doc").bind().first()).toBeNull();
  });

  it("turned off again, the sweep skips them, and no row or doc went anywhere", async () => {
    await setRetentionDays(db, "u1", 1, T0);
    const { material } = await seed("u1", T0);
    await settingsPutReply(db, "u1", { days: null }, T0);
    expect(await getRetentionDays(db, "u1")).toBeNull();
    expect(await sweepVibeDocs(db, null, T0 + 400 * DAY)).toBe(0);
    expect(await getReadMaterialById("u1", material)).not.toBeNull();
  });

  it("a legacy 30, or any row the old field saved, is not a choice", async () => {
    legacyRow("u1", 30);
    const { material } = await seed("u1", T0);
    expect(await getRetentionDays(db, "u1")).toBeNull();
    expect(await sweepVibeDocs(db, null, T0 + 400 * DAY)).toBe(0);
    expect(await getReadMaterialById("u1", material)).not.toBeNull();
    // Choosing afterwards counts, even the same number.
    await setRetentionDays(db, "u1", 30, T0);
    expect(await getRetentionDays(db, "u1")).toBe(30);
  });

  it("the migration: 30 stays unset, a typed number stays chosen, no row deleted", () => {
    const all = testSchema();
    const [before, after] = all.split("ALTER TABLE vibe_settings ADD COLUMN chosen");
    const fresh = createTestD1(before);
    for (const u of ["a", "b"])
      fresh.exec(
        `INSERT INTO user (id, email, name, emailVerified, createdAt, updatedAt) VALUES ('${u}', '${u}@example.com', '${u}', 1, 0, 0)`,
      );
    fresh.exec(
      `INSERT INTO vibe_settings (user_id, retention_days, updated_ms) VALUES ('a', 30, 0)`,
    );
    fresh.exec(
      `INSERT INTO vibe_settings (user_id, retention_days, updated_ms) VALUES ('b', 7, 0)`,
    );
    fresh.exec(`ALTER TABLE vibe_settings ADD COLUMN chosen${after}`);
    const rows = fresh.prepare(
      "SELECT user_id, retention_days, chosen FROM vibe_settings ORDER BY user_id",
    );
    return rows
      .bind()
      .all()
      .then(({ results }) =>
        expect(results).toEqual([
          { user_id: "a", retention_days: 30, chosen: 0 },
          { user_id: "b", retention_days: 7, chosen: 1 },
        ]),
      );
  });

  it("the Preferences field saves only a change, and shows off by default", () => {
    const src = readFileSync("app/(app)/vibe/VibeRetention.tsx", "utf8");
    expect(src).toContain("if (text === stored.current) return;");
    expect(src).toContain('useState("")');
    expect(src).toContain("placeholder={t.retentionOff.value}");
  });

  it("follows the user's setting, per user", async () => {
    await setRetentionDays(db, "u1", 1, T0);
    await setRetentionDays(db, "u2", 90, T0);
    const a = await seed("u1", T0);
    const b = await seed("u2", T0);
    const c = await seed("u3", T0);
    expect(await sweepVibeDocs(db, null, T0 + 2 * DAY)).toBe(1);
    expect(await getReadMaterialById("u1", a.material)).toBeNull();
    expect(await getReadMaterialById("u2", b.material)).not.toBeNull();
    expect(await getReadMaterialById("u3", c.material)).not.toBeNull();
  });

  it("takes the large content in R2 and the reader rows with it", async () => {
    const { id, material } = await seed("u1", T0);
    const word = (n: number) => n.toString(26).replace(/\d/g, (d) => "qrstuvwxyz"[Number(d)]);
    const big = Array.from({ length: 100 }, (_, l) =>
      Array.from({ length: 100 }, (_, i) => `zz${word(l * 100 + i + 700)}`).join(" "),
    );
    await linesReply(db, "u1", id, { from: 1, lines: big }, T0);
    const m = await getReadMaterialById("u1", material);
    expect(m!.r2Key).toBeTruthy();
    const deleted: string[] = [];
    await setRetentionDays(db, "u1", 30, T0);
    await sweepVibeDocs(db, { delete: async (k) => void deleted.push(k) }, T0 + 31 * DAY);
    expect(deleted).toEqual([m!.r2Key!]);
  });

  it("with a number, clears a start that never heard anything, and leaves other materials", async () => {
    await setRetentionDays(db, "u1", 30, T0);
    await startReply(db, "u1", { tap: true, title: "T" }, T0);
    const { saveReadMaterial } = await import("@/lib/getReadMaterialsCollection");
    const other = await saveReadMaterial("u1", "A book", "a", ["a"]);
    expect(await sweepVibeDocs(db, null, T0 + 40 * DAY)).toBe(1);
    expect(await getReadMaterialById("u1", String(other._id))).not.toBeNull();
  });

  it("the setting takes whole days in range only", async () => {
    for (const bad of [0, -1, 1.5, "7", null, 99_999]) expect(checkRetention(bad)).toBeNull();
    expect(checkRetention(7)).toBe(7);
    expect((await settingsPutReply(db, "u1", { days: 0 }, T0)).status).toBe(400);
    expect((await settingsPutReply(db, "u1", { days: 7 }, T0)).status).toBe(200);
    expect(await getRetentionDays(db, "u1")).toBe(7);
  });

  it("runs on the Worker's existing daily trigger, with no new one", () => {
    expect(readFileSync("worker.ts", "utf8")).toContain("sweepVibeDocs(");
    expect(readFileSync("wrangler.jsonc", "utf8")).toContain('"crons": ["5 0 * * *"]');
  });
});

describe("polish", () => {
  const book = { source: "vibe", shape: { raw: true } } as unknown as BookMeta;
  it("is never offered on a transcript, followed live or not", () => {
    expect(offerShown({ book, stream: null, offerOn: true, skipped: false })).toBe(false);
    expect(offerShown({ book, stream: "live", offerOn: true, skipped: false })).toBe(false);
    expect(polishActionShown(book)).toBe(false);
    expect(polishRefused(book)).toBe(true);
  });
  it("the source survives a round trip through the stored meta", () => {
    const m = parseBookMeta(
      JSON.stringify({ kind: "lianki-book", v: 1, source: "vibe", chapters: [] }),
    );
    expect(m?.source).toBe("vibe");
  });
  it("the reader's live card, which translates the newest line by itself, is not on a transcript", () => {
    expect(readFileSync("app/(app)/read/[id]/ReaderV2.tsx", "utf8")).toContain(
      'liveTail !== null && book?.source !== "vibe"',
    );
  });
  it("both polish routes refuse it", () => {
    for (const r of ["polish", "polish-live"])
      expect(readFileSync(`app/api/read/[id]/${r}/route.ts`, "utf8")).toContain("polishRefused(");
  });
});

// ── the session, on the real mic core ────────────────────────────────────────

function fakeStt(state: LocalState = "ready") {
  const subs = new Set<(s: LocalState) => void>();
  let st = state;
  const utts: {
    frames: number;
    cancelled: boolean;
    resolve?: (f: unknown) => void;
    reject?: (e: Error) => void;
  }[] = [];
  const c: VibeStt & { set(s: LocalState): void; utts: typeof utts; closed: number } = {
    utts,
    closed: 0,
    set(s) {
      st = s;
      for (const f of subs) f(s);
    },
    state: () => st,
    subscribe(f) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    warm() {},
    keep() {},
    close() {
      c.closed++;
    },
    connected: () => st === "ready",
    begin() {
      const u: (typeof utts)[number] = { frames: 0, cancelled: false };
      utts.push(u);
      return {
        frame: () => void u.frames++,
        cancel: () => void (u.cancelled = true),
        end: () =>
          new Promise((resolve, reject) => {
            u.resolve = resolve as (f: unknown) => void;
            u.reject = reject;
          }),
      } as never;
    },
  };
  return c;
}

function harness(over: Partial<VibeDeps> & { stt?: () => VibeStt | null } = {}) {
  const stt = fakeStt();
  const posted: { from: number; lines: string[] }[] = [];
  const states: string[] = [];
  let tracks = { stopped: 0 };
  let ev: Parameters<VibeDeps["load"]>[0] | null = null;
  const views: VibeView[] = [];
  const gum = mock(async () => ({
    getTracks: () => [{ stop: () => void tracks.stopped++ }],
  }));
  let chatHolds = 0;
  let chatReleased = 0;
  const watchers: ((w: "hidden" | "offline") => void)[] = [];
  const apiStart = mock<VibeDeps["api"]["start"]>(async () => ({ ok: true, id: "doc" }));
  let next = 0;
  const deps: VibeDeps = {
    api: {
      start: apiStart,
      lines: async (_id, b) => {
        posted.push(b);
        next = b.from + b.lines.length;
        return { ok: true, next, material: "mat", langs: b.lines.map(() => "en") };
      },
      state: async (_id, s) => {
        states.push(s);
        return { ok: true };
      },
    },
    stt: () => stt,
    getStream: gum,
    load: async (e) => {
      ev = e;
      return {
        start: () => {},
        pause: () => {},
        flush: () => {},
        destroy: () => {},
      };
    },
    holdChatMic: () => {
      chatHolds++;
      return () => void chatReleased++;
    },
    watchPage: (f) => {
      watchers.push(f);
      return () => {};
    },
    onView: (v) => void views.push(v),
    ...over,
  };
  const s = createVibeSession(deps);
  const say = async (text: string) => {
    ev!.onSpeechStart();
    for (let i = 0; i < 3; i++) ev!.onFrame?.(new Float32Array(512).fill(0.2), 0.9);
    ev!.onSpeechEnd(new Float32Array(16_000).fill(0.2));
    await tick();
    const u = stt.utts[stt.utts.length - 1];
    u.resolve?.({ text, lang: "en", signals: { decoder: "ctc" } });
    await settle();
  };
  return {
    s,
    stt,
    posted,
    states,
    gum,
    apiStart,
    say,
    views,
    watchers,
    ev: () => ev!,
    tracks: () => tracks.stopped,
    chat: () => ({ chatHolds, chatReleased }),
  };
}
const go = (s: ReturnType<typeof createVibeSession>) =>
  s.start({ tap: true, title: "Conversation" });

describe("the session: starting", () => {
  it("without the tap: no server call, no microphone", async () => {
    const h = harness();
    await h.s.start({ tap: false, title: "x" });
    expect(h.apiStart).not.toHaveBeenCalled();
    expect(h.gum).not.toHaveBeenCalled();
    expect(h.s.view().end).toBe("not-tapped");
  });

  it("server refusal (flag off): the microphone is never asked for", async () => {
    const h = harness();
    h.apiStart.mockImplementation(async () => ({ ok: false, status: 404 }));
    await go(h.s);
    expect(h.gum).not.toHaveBeenCalled();
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "refused" });
    expect(h.chat().chatHolds).toBe(0);
  });

  it("the Mac unreachable: the microphone is never asked for, and no cloud instead", async () => {
    const stt = fakeStt("down");
    const h = harness({ stt: () => stt });
    await go(h.s);
    expect(h.gum).not.toHaveBeenCalled();
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "no-stt" });
    expect(h.states).toEqual(["stopped"]);
  });

  it("a refused microphone ends it cleanly", async () => {
    const denied = Object.assign(new Error("no"), { name: "NotAllowedError" });
    const h = harness({
      getStream: async () => {
        throw denied;
      },
    });
    await go(h.s);
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "no-mic" });
    expect(h.chat().chatReleased).toBe(1);
  });

  it("uses the tailnet route, never the tunnel Cloudflare could hear", () => {
    expect(vibeRoute(null)).toBe("wss://taku.onca-tint.ts.net/lianki-stt");
    expect(vibeRoute("wss://stt.lianki.com")).toBeNull();
    expect(vibeRoute("off")).toBeNull();
    expect(vibeRoute("ws://localhost:5193")).toBe("ws://localhost:5193/");
    expect(vibeRoute("wss://mac.ts.net/x wss://stt.lianki.com")).toBe("wss://mac.ts.net/x");
  });
});

describe("the session: keep going", () => {
  const more = {
    id: "doc",
    material: "mat",
    lines: [{ text: "said before", lang: "fr" }],
    next: 1,
  };

  it("only by a tap; a refusal opens nothing", async () => {
    const h = harness();
    await h.s.continueDoc({ tap: false, ...more });
    expect(h.states).toEqual([]);
    expect(h.gum).not.toHaveBeenCalled();
    const r = harness({
      api: {
        start: async () => ({ ok: true, id: "doc" }),
        lines: async () => ({ ok: false, status: 409 }),
        state: async () => ({ ok: false, status: 404 }),
      },
    });
    await r.s.continueDoc({ tap: true, ...more });
    expect(r.gum).not.toHaveBeenCalled();
    expect(r.s.view()).toMatchObject({ status: "stopped", end: "refused" });
  });

  it("asks the server, then the mic, and adds after what is there", async () => {
    const h = harness();
    await h.s.continueDoc({ tap: true, ...more });
    await settle();
    expect(h.states).toEqual(["running"]);
    expect(h.gum).toHaveBeenCalledTimes(1);
    expect(h.s.view()).toMatchObject({ status: "running", doc: "doc", material: "mat" });
    await h.say("something new was said");
    expect(h.posted).toEqual([{ from: 1, lines: ["something new was said"] }]);
    expect(h.s.view().lines).toEqual([
      { text: "said before", lang: "fr" },
      { text: "something new was said", lang: "en" },
    ]);
  });

  it("a stop on a log page does not delete the doc: it has text", async () => {
    const h = harness();
    await h.s.continueDoc({ tap: true, ...more });
    await settle();
    await h.s.stop();
    expect(h.s.view()).toMatchObject({ status: "stopped", material: "mat", doc: "doc" });
    expect(h.states).toEqual(["running", "stopped"]);
  });
});

describe("the session: running", () => {
  it("heard lines go to the transcript", async () => {
    const h = harness();
    await go(h.s);
    expect(h.s.view().status).toBe("running");
    await h.say("Hello there my friend.");
    await h.say("Nice to meet you today.");
    expect(h.posted.flatMap((p) => p.lines)).toEqual([
      "Hello there my friend.",
      "Nice to meet you today.",
    ]);
    expect(h.posted.map((p) => p.from)).toEqual([0, 1]);
    expect(h.s.view().material).toBe("mat");
    expect(h.s.view().lines[0].lang).toBe("en");
  });

  it("holds the chat's mic for as long as it runs", async () => {
    const h = harness();
    await go(h.s);
    expect(h.chat()).toEqual({ chatHolds: 1, chatReleased: 0 });
    await h.s.stop();
    expect(h.chat()).toEqual({ chatHolds: 1, chatReleased: 1 });
  });

  it("the Mac failing on a line drops it: nothing goes to the cloud", async () => {
    const f = mock(async () => new Response("{}"));
    const real = globalThis.fetch;
    globalThis.fetch = f as unknown as typeof fetch;
    try {
      const h = harness();
      await go(h.s);
      h.ev().onSpeechStart();
      h.ev().onSpeechEnd(new Float32Array(16_000).fill(0.2));
      await tick();
      h.stt.utts[0].reject?.(new Error("timeout"));
      await settle();
      expect(h.posted).toEqual([]);
      expect(h.s.view().lost).toBe(1);
      expect(f).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = real;
    }
  });

  it("makes no sound and saves no clip: none of those paths are imported", () => {
    for (const file of [
      "lib/vibe/session.ts",
      "lib/vibe/browser.ts",
      "app/(app)/vibe/VibeClient.tsx",
    ]) {
      const src = readFileSync(file, "utf8");
      for (const bad of [
        "clips",
        "postClip",
        "sideClip",
        "postStt",
        "/api/debug/stt",
        "cues",
        "pageCues",
        "AudioContext",
        "speechSynthesis",
        "voice-dispatch",
        "voiceTap",
        "DebugChat",
      ])
        expect(src.replace(/^\s*(\/\/|\*).*$/gm, "")).not.toContain(bad);
    }
    const capture = readFileSync("packages/debug-chat/src/MicButton.tsx", "utf8");
    const part = capture.slice(capture.indexOf("export const voiceCapture"));
    expect(part.slice(0, part.indexOf("});"))).not.toMatch(/clip|cue|postStt/i);
  });
});

describe("the session: pause", () => {
  it("stops the feed at once and writes nothing more", async () => {
    const h = harness();
    await go(h.s);
    await h.say("Said before the pause here.");
    h.ev().onSpeechStart();
    h.ev().onFrame?.(new Float32Array(512).fill(0.2), 0.9);
    const live = h.stt.utts[h.stt.utts.length - 1];
    const stops = h.tracks();
    await h.s.pause();
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "user" });
    expect(h.tracks()).toBe(stops + 1);
    expect(live.cancelled).toBe(true);
    expect(h.stt.closed).toBe(1);
    expect(h.states).toEqual(["paused"]);

    const frames = live.frames;
    const utts = h.stt.utts.length;
    h.ev().onSpeechStart();
    h.ev().onFrame?.(new Float32Array(512).fill(0.2), 0.9);
    h.ev().onSpeechEnd(new Float32Array(16_000).fill(0.2));
    await settle();
    expect(live.frames).toBe(frames);
    expect(h.stt.utts.length).toBe(utts);
    expect(h.posted.flatMap((p) => p.lines)).toEqual(["Said before the pause here."]);
  });

  it("a final landing after the pause is thrown away", async () => {
    const h = harness();
    await go(h.s);
    h.ev().onSpeechStart();
    h.ev().onSpeechEnd(new Float32Array(16_000).fill(0.2));
    await tick();
    const u = h.stt.utts[0];
    await h.s.pause();
    u.resolve?.({ text: "This came too late to keep.", signals: { decoder: "ctc" } });
    await settle();
    expect(h.posted).toEqual([]);
    expect(h.s.view().lines).toEqual([]);
  });

  it("resume is his tap: it reopens and goes on, from the next line", async () => {
    const h = harness();
    await go(h.s);
    await h.say("First line said here today.");
    await h.s.pause();
    expect(h.gum).toHaveBeenCalledTimes(1);
    await h.s.resume();
    expect(h.s.view().status).toBe("running");
    expect(h.gum).toHaveBeenCalledTimes(2);
    expect(h.states).toEqual(["paused", "running"]);
    await h.say("Second line said here today.");
    expect(h.posted[1]).toEqual({ from: 1, lines: ["Second line said here today."] });
  });

  for (const why of ["hidden", "offline"] as const)
    it(`${why} pauses by itself, visibly, and does not come back by itself`, async () => {
      const h = harness();
      await go(h.s);
      const stops = h.tracks();
      h.watchers[0](why);
      await settle();
      expect(h.s.view()).toMatchObject({ status: "paused", pause: why });
      expect(h.tracks()).toBe(stops + 1);
      await settle();
      expect(h.s.view().status).toBe("paused");
      expect(h.gum).toHaveBeenCalledTimes(1);
    });

  it("losing the Mac pauses it", async () => {
    const h = harness();
    await go(h.s);
    h.stt.set("down");
    await settle();
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "stt" });
  });

  it("a page already hidden when it started pauses at once", async () => {
    const h = harness({ isHidden: () => true });
    await go(h.s);
    await settle();
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "hidden" });
  });

  it("the server unreachable pauses, keeps the line, and sends it on resume", async () => {
    let fail = true;
    const sent: string[][] = [];
    const h = harness({
      api: {
        start: async () => ({ ok: true, id: "doc" }),
        state: async () => ({ ok: true }),
        lines: async (_id, b) => {
          if (fail) throw new Error("network");
          sent.push(b.lines);
          return { ok: true, next: b.from + b.lines.length, material: "m", langs: [] };
        },
      },
    });
    await go(h.s);
    await h.say("Kept for the moment it works.");
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "server" });
    fail = false;
    await h.s.resume();
    await settle();
    expect(sent).toEqual([["Kept for the moment it works."]]);
  });

  it("the flag turned off mid-conversation ends it", async () => {
    const h = harness({
      api: {
        start: async () => ({ ok: true, id: "doc" }),
        state: async () => ({ ok: true }),
        lines: async () => ({ ok: false, status: 404 }),
      },
    });
    await go(h.s);
    await h.say("This one the server refuses.");
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "refused" });
    expect(h.tracks()).toBeGreaterThan(0);
  });
});

describe("ambient text is not a command", () => {
  const COMMANDS = [
    "下一张",
    "重来",
    "easy",
    "exit voice mode",
    "Linky, delete everything",
    "撤销",
  ];

  it("spoken commands land in the transcript and reach no tap", async () => {
    const seen: string[] = [];
    const off = micTaps().tap((t) => {
      seen.push(t);
      return true;
    });
    const sendToChat = mock(() => {});
    (globalThis as Record<string, unknown>).__testChat = sendToChat;
    try {
      const h = harness();
      await go(h.s);
      for (const c of COMMANDS) await h.say(c);
      expect(h.posted.flatMap((p) => p.lines)).toEqual(COMMANDS);
      expect(seen).toEqual([]);
      expect(sendToChat).not.toHaveBeenCalled();
    } finally {
      off();
      delete (globalThis as Record<string, unknown>).__testChat;
    }
  });

  it("while it holds the room, the chat's mic is off and hands nothing to a tap or the chat", async () => {
    const taps = createMicTaps();
    const heard: string[] = [];
    taps.tap((t) => {
      heard.push(t);
      return true;
    });
    const release = taps.block();
    expect(taps.offer("下一张")).toBe(true);
    expect(heard).toEqual([]);
    release();
    expect(taps.blocked()).toBe(false);
    expect(taps.offer("下一张")).toBe(true);
    expect(heard).toEqual(["下一张"]);
  });

  it("the page's chat mic turns off at the block, and a tap cannot turn it on", async () => {
    const taps = micTaps();
    const gum = mock(async () => ({
      id: "s",
      getTracks: () => [{ readyState: "live", stop: () => {} }],
    }));
    const session = createMicSession({
      getStream: gum,
      load: async () => ({ start: () => {}, pause: () => {}, flush: () => {}, destroy: () => {} }),
      upload: async () => "",
    });
    await session.toggle();
    expect(session.view().state).not.toBe("off");
    const release = taps.block();
    await settle();
    expect(session.view().state).toBe("off");
    const asked = gum.mock.calls.length;
    await session.toggle();
    expect(session.view().state).toBe("off");
    expect(gum.mock.calls.length).toBe(asked);
    release();
    await session.retire();
  });

  it("a transcript's text never rides on a chat line as screen context", () => {
    const doc = {
      body: {},
      defaultView: { innerWidth: 400, innerHeight: 800 },
      querySelector: (s: string) => (s === "[data-lk-private-screen]" ? {} : null),
      createTreeWalker: () => {
        throw new Error("must not walk a private page");
      },
    } as unknown as Document;
    expect(screenText(doc)).toBe("");
  });
});

describe("screen context on an ordinary page, for contrast", () => {
  (globalThis as { NodeFilter?: unknown }).NodeFilter ??= { SHOW_TEXT: 4 };
  const fakeDoc = (privatePage: boolean) => {
    const parent = { closest: () => null, checkVisibility: () => true };
    const nodes = [{ textContent: "  invented   words on screen ", parentElement: parent }];
    const win = { innerWidth: 400, innerHeight: 800, location: { pathname: "/words" } };
    const doc = {
      title: "T",
      body: {},
      defaultView: win,
      querySelector: () => (privatePage ? {} : null),
      createRange: () => ({
        selectNodeContents() {},
        getBoundingClientRect: () => ({
          width: 9,
          height: 9,
          top: 1,
          left: 1,
          bottom: 9,
          right: 9,
        }),
      }),
      createTreeWalker: () => {
        let i = 0;
        return { nextNode: () => nodes[i++] ?? null };
      },
    };
    return doc as unknown as Document;
  };

  it("sends what is on screen, and nothing from a private one", () => {
    expect(screenText(fakeDoc(false))).toBe("invented words on screen");
    expect(pageScene(fakeDoc(false))?.screen).toBe("invented words on screen");
    expect(pageScene(fakeDoc(true))?.screen ?? "").toBe("");
    expect(screenText({ body: null, defaultView: null } as unknown as Document)).toBe("");
    expect(pageScene({ defaultView: null } as unknown as Document)).toBeUndefined();
    expect(
      pageScene({
        ...fakeDoc(false),
        defaultView: {
          get location() {
            throw new Error("no");
          },
        },
      } as unknown as Document),
    ).toBeUndefined();
  });
});

describe("the session: the edges", () => {
  it("waits for the Mac, then opens the microphone", async () => {
    const stt = fakeStt("connecting");
    const h = harness({ stt: () => stt });
    const started = go(h.s);
    await settle();
    expect(h.gum).not.toHaveBeenCalled();
    stt.set("ready");
    await started;
    expect(h.s.view().status).toBe("running");
  });

  it("takes the timers it is given", async () => {
    const set: number[] = [];
    let cleared = 0;
    const stt = fakeStt("connecting");
    const h = harness({
      stt: () => stt,
      setTimer: (_f, ms) => {
        set.push(ms);
        return 1;
      },
      clearTimer: () => void cleared++,
    });
    const started = go(h.s);
    await settle();
    stt.set("ready");
    await started;
    expect(set[0]).toBe(3000);
    expect(cleared).toBeGreaterThan(0);
  });

  it("a Mac that goes down mid-wait ends it, and the default timer is cleared", async () => {
    const stt = fakeStt("connecting");
    const h = harness({ stt: () => stt });
    const started = go(h.s);
    await settle();
    stt.set("idle");
    stt.set("down");
    await started;
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "no-stt" });
  });

  it("stopping while the Mac is being reached opens nothing afterwards", async () => {
    const stt = fakeStt("connecting");
    const h = harness({ stt: () => stt });
    const started = go(h.s);
    await settle();
    const stopped = h.s.stop();
    stt.set("ready");
    await Promise.all([started, stopped]);
    expect(h.gum).not.toHaveBeenCalled();
    expect(h.s.view().status).toBe("stopped");
  });

  it("a fallback VAD that asks for a stream of its own gets one", async () => {
    const h = harness({
      getStream: async () => {
        throw new Error("first try fails, not denied");
      },
      fallback: async () => {
        throw new Error("no fallback either");
      },
    });
    await go(h.s);
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "no-mic" });
  });

  it("gives up on a Mac that never answers, by the real timer", async () => {
    const stt = fakeStt("connecting");
    const h = harness({ stt: () => stt, readyMs: 1 });
    await go(h.s);
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "no-stt" });
    expect(h.gum).not.toHaveBeenCalled();
  });

  it("no route on this page: nothing starts", async () => {
    const h = harness({ stt: () => null });
    await go(h.s);
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "no-stt" });
  });

  it("the energy VAD steps in when Silero cannot load", async () => {
    let fell = false;
    const h = harness({
      load: async () => {
        throw new Error("no wasm");
      },
      fallback: async () => {
        fell = true;
        return { start: () => {}, pause: () => {}, flush: () => {}, destroy: () => {} };
      },
    });
    await go(h.s);
    expect(fell).toBe(true);
    expect(h.s.view().status).toBe("running");
  });

  it("the microphone going away pauses it", async () => {
    const track: { stop(): void; onended?: unknown } = { stop() {} };
    const h = harness({ getStream: async () => ({ getTracks: () => [track] }) });
    await go(h.s);
    (track.onended as () => void)();
    await settle();
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "mic" });
  });

  it("a stream that arrives after a stop is stopped at once", async () => {
    let give: (s: { getTracks(): { stop(): void }[] }) => void = () => {};
    let stopped = 0;
    const h = harness({
      getStream: () =>
        new Promise((r) => {
          give = r;
        }),
    });
    const started = go(h.s);
    await settle();
    await h.s.stop();
    give({ getTracks: () => [{ stop: () => void stopped++ }] });
    await started;
    await settle();
    expect(stopped).toBe(1);
  });

  it("starting twice and resuming or stopping out of turn do nothing", async () => {
    const h = harness();
    await h.s.resume();
    await h.s.stop();
    expect(h.s.view().status).toBe("idle");
    h.s.reset();
    await go(h.s);
    await go(h.s);
    expect(h.apiStart).toHaveBeenCalledTimes(1);
    h.s.reset();
    expect(h.s.view().status).toBe("running");
  });

  it("a new conversation after a stop starts clean", async () => {
    const h = harness();
    await go(h.s);
    await h.say("From the first conversation.");
    expect(h.s.sent()).toBe(1);
    await h.s.stop();
    h.s.reset();
    expect(h.s.view()).toMatchObject({ status: "idle", lines: [] });
    await go(h.s);
    expect(h.s.sent()).toBe(0);
    expect(h.s.view().lines).toEqual([]);
  });

  it("a resume the server refuses, or cannot be asked about, does not listen", async () => {
    for (const [answer, end] of [
      [{ ok: false, status: 409 }, "gone"],
      [{ ok: false, status: 404 }, "refused"],
    ] as const) {
      let first = true;
      const h = harness({
        api: {
          start: async () => ({ ok: true, id: "doc" }),
          lines: async () => ({ ok: true, next: 0, material: null, langs: [] }),
          state: async () => {
            if (first) {
              first = false;
              return { ok: true };
            }
            return answer;
          },
        },
      });
      await go(h.s);
      await h.s.pause();
      await h.s.resume();
      expect(h.s.view()).toMatchObject({ status: "stopped", end });
      expect(h.gum).toHaveBeenCalledTimes(1);
    }
    let calls = 0;
    const h = harness({
      api: {
        start: async () => ({ ok: true, id: "doc" }),
        lines: async () => ({ ok: true, next: 0, material: null, langs: [] }),
        state: async () => {
          if (++calls > 1) throw new Error("network");
          return { ok: true };
        },
      },
    });
    await go(h.s);
    await h.s.pause();
    await h.s.resume();
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "server" });
    expect(h.gum).toHaveBeenCalledTimes(1);
  });

  it("a resume with the Mac gone stays paused and says so", async () => {
    let stt = fakeStt();
    const h = harness({ stt: () => stt });
    await go(h.s);
    await h.s.pause();
    stt = fakeStt("down");
    await h.s.resume();
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "stt" });
  });

  it("a server's other refusals of a line each say what they mean", async () => {
    for (const [status, want] of [
      [409, { status: "stopped", end: "gone" }],
      [413, { status: "stopped", end: "full" }],
      [429, { status: "paused", pause: "server" }],
    ] as const) {
      const h = harness({
        api: {
          start: async () => ({ ok: true, id: "doc" }),
          state: async () => ({ ok: true }),
          lines: async () => ({ ok: false, status }),
        },
      });
      await go(h.s);
      await h.say("One invented line for the refusal.");
      expect(h.s.view()).toMatchObject(want);
    }
  });

  it("a line refused because it is paused just waits", async () => {
    let refuse = true;
    const h = harness({
      api: {
        start: async () => ({ ok: true, id: "doc" }),
        state: async () => ({ ok: true }),
        lines: async (_i, b) =>
          refuse
            ? { ok: false, status: 409 }
            : { ok: true, next: b.from + b.lines.length, material: "m", langs: [] },
      },
    });
    await go(h.s);
    h.ev().onSpeechStart();
    h.ev().onSpeechEnd(new Float32Array(16_000).fill(0.2));
    await tick();
    const u = h.stt.utts[0];
    u.resolve?.({ text: "Heard just before the pause.", signals: { decoder: "ctc" } });
    const paused = h.s.pause();
    await paused;
    await settle();
    refuse = false;
    expect(["paused", "stopped"]).toContain(h.s.view().status);
  });

  it("the server unreachable never keeps it listening or stuck", async () => {
    const down = async () => {
      throw new Error("network");
    };
    // A stop with neither the state nor the last line getting through still stops.
    const h = harness({
      api: { start: async () => ({ ok: true, id: "doc" }), state: down, lines: down },
    });
    await go(h.s);
    await h.say("This never reaches the server at all.");
    expect(h.s.view()).toMatchObject({ status: "paused", pause: "server" });
    await h.s.stop();
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "user" });

    // A pause with the state call failing is still a pause.
    const p = harness({
      api: { start: async () => ({ ok: true, id: "doc" }), state: down, lines: down },
    });
    await go(p.s);
    await p.s.pause();
    expect(p.s.view()).toMatchObject({ status: "paused", pause: "user" });

    // A failed start's clean-up may fail too.
    const stt = fakeStt("down");
    const f = harness({
      stt: () => stt,
      api: { start: async () => ({ ok: true, id: "doc" }), state: down, lines: down },
    });
    await go(f.s);
    expect(f.s.view()).toMatchObject({ status: "stopped", end: "no-stt" });
  });

  it("a final the Mac never gives after a pause is not counted as lost", async () => {
    const h = harness();
    await go(h.s);
    h.ev().onSpeechStart();
    h.ev().onSpeechEnd(new Float32Array(16_000).fill(0.2));
    await tick();
    const u = h.stt.utts[0];
    await h.s.pause();
    u.reject?.(new Error("closed"));
    await settle();
    expect(h.s.view().lost).toBe(0);
  });

  it("a start the network swallows ends it, with nothing opened", async () => {
    const h = harness();
    h.apiStart.mockImplementation(async () => {
      throw new Error("network");
    });
    await go(h.s);
    expect(h.s.view()).toMatchObject({ status: "stopped", end: "refused" });
    expect(h.gum).not.toHaveBeenCalled();
  });
});
