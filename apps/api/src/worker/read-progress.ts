import { Hono } from "hono";
import { State } from "ts-fsrs";
import type { D1Like } from "@/lib/d1/types";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo } from "@/lib/repos/d1Repos";
import type { RoadmapNode, RoadmapNodeProgress } from "@/types/roadmap";
import { resolveEmail, resolveUser } from "./session";

// CF-native ports of read-materials (D1 + R2) and roadmap progress (FSRS
// maturity). Read-materials D1/R2 ops are reimplemented here (the Next module
// app/[locale]/read/getReadMaterialsCollection.ts imports the Mongo client).

const GRIDFS_THRESHOLD = 32 * 1024; // 32 KB → store content in R2
const R2_PREFIX = "read/";
const MATURE_STABILITY_DAYS = 21;

type ReadRow = {
  id: string;
  user_id: string;
  title: string;
  lines: string;
  r2_key: string | null;
  content: string | null;
  created_at: string;
  updated_at: string;
};
type Material = {
  _id: string;
  title: string;
  lines: string[];
  r2Key?: string;
  content?: string;
  createdAt: Date;
  updatedAt: Date;
};

const rowToMaterial = (r: ReadRow): Material => ({
  _id: r.id,
  title: r.title,
  lines: JSON.parse(r.lines || "[]"),
  r2Key: r.r2_key ?? undefined,
  content: r.content ?? undefined,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
});

async function saveMaterial(
  db: D1Like,
  blobs: R2Bucket,
  userId: string,
  title: string,
  content: string,
  lines: string[],
): Promise<Material> {
  const now = new Date();
  const large = new TextEncoder().encode(content).length >= GRIDFS_THRESHOLD;
  const id = crypto.randomUUID();
  const r2Key = large ? `${R2_PREFIX}${id}` : undefined;
  if (r2Key) await blobs.put(r2Key, content);
  await db
    .prepare(
      `INSERT INTO read_materials (id, user_id, title, lines, r2_key, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      userId,
      title,
      JSON.stringify(lines),
      r2Key ?? null,
      large ? null : content,
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  return {
    _id: id,
    title,
    lines,
    r2Key,
    content: large ? undefined : content,
    createdAt: now,
    updatedAt: now,
  };
}

async function materialContent(blobs: R2Bucket, m: Material): Promise<string> {
  if (m.content) return m.content;
  if (m.r2Key) {
    const obj = await blobs.get(m.r2Key);
    return obj ? await obj.text() : "";
  }
  return "";
}

export function mountReadProgress(app: Hono<any>) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  // ── Read materials (session-authed, keyed by user id) ────────────────────────
  app.get("/api/read", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const sp = new URL(c.req.raw.url).searchParams;
    let page = parseInt(sp.get("page") ?? "", 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    let pageSize = parseInt(sp.get("pageSize") ?? "", 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 10;
    else if (pageSize > 100) pageSize = 100;

    const db = c.env.DB as D1Like;
    const { results } = await db
      .prepare(
        "SELECT * FROM read_materials WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .bind(user.id, pageSize, (page - 1) * pageSize)
      .all<ReadRow>();
    const totalRow = await db
      .prepare("SELECT COUNT(*) AS c FROM read_materials WHERE user_id = ?")
      .bind(user.id)
      .first<{ c: number }>();
    const total = totalRow?.c ?? 0;
    return c.json({
      materials: results.map(rowToMaterial).map((m) => ({
        id: m._id,
        title: m.title,
        lines: m.lines,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  });

  app.post("/api/read", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body === null || typeof body !== "object")
      return c.json({ error: "Request body must be a JSON object" }, 400);
    const { title, content } = body as { title?: unknown; content?: unknown };
    if (typeof content !== "string" || content.length === 0)
      return c.json({ error: "Content is required" }, 400);
    if (typeof title !== "undefined" && typeof title !== "string")
      return c.json({ error: "Title must be a string" }, 400);

    const lines = content
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const materialTitle =
      typeof title === "string" && title.length > 0
        ? title
        : `Import ${new Date().toLocaleDateString()}`;
    const m = await saveMaterial(c.env.DB, c.env.BLOBS, user.id, materialTitle, content, lines);
    return c.json({
      id: m._id,
      title: m.title,
      lines: m.lines,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    });
  });

  app.get("/api/read/:id", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const row = await (c.env.DB as D1Like)
      .prepare("SELECT * FROM read_materials WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), user.id)
      .first<ReadRow>();
    if (!row) return c.json({ error: "Material not found" }, 404);
    const m = rowToMaterial(row);
    return c.json({
      id: m._id,
      title: m.title,
      content: await materialContent(c.env.BLOBS, m),
      lines: m.lines,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    });
  });

  app.delete("/api/read/:id", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    const db = c.env.DB as D1Like;
    const id = c.req.param("id");
    const row = await db
      .prepare("SELECT * FROM read_materials WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .first<ReadRow>();
    if (!row) return c.json({ error: "Material not found" }, 404);
    if (row.r2_key) await c.env.BLOBS.delete(row.r2_key);
    await db
      .prepare("DELETE FROM read_materials WHERE id = ? AND user_id = ?")
      .bind(id, user.id)
      .run();
    return c.json({ success: true });
  });

  // ── Roadmap node progress (FSRS maturity) — token-or-session authed ───────────
  app.get("/api/roadmap/:id/progress", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.text("Unauthorized", 401);
    const db = c.env.DB as D1Like;
    const goal = await new RoadmapGoalsD1Repo(db, email).getById(c.req.param("id"));
    if (!goal) return c.text("Not found", 404);
    const allNotes = await new FsrsNotesD1Repo(db, email).listAll();

    const normalizedNodes = goal.nodes.map((node: RoadmapNode) => ({
      ...node,
      normalizedKeywords: node.keywords.map((kw) => kw.toLowerCase()),
    }));
    const nodeCounts = normalizedNodes.map(() => ({ totalCards: 0, matureCards: 0 }));

    for (const note of allNotes) {
      const text = `${note.url} ${note.title ?? ""}`.toLowerCase();
      const isMature =
        note.card.state === State.Review && note.card.stability >= MATURE_STABILITY_DAYS;
      for (let i = 0; i < normalizedNodes.length; i++) {
        if (normalizedNodes[i].normalizedKeywords.some((kw) => text.includes(kw))) {
          nodeCounts[i].totalCards += 1;
          if (isMature) nodeCounts[i].matureCards += 1;
        }
      }
    }

    const nodes: RoadmapNodeProgress[] = goal.nodes.map((node: RoadmapNode, i: number) => {
      const { totalCards, matureCards } = nodeCounts[i];
      return {
        ...node,
        totalCards,
        matureCards,
        maturityRate: totalCards === 0 ? 0 : matureCards / totalCards,
      };
    });
    const totalCards = nodes.reduce((s, n) => s + n.totalCards, 0);
    const matureCards = nodes.reduce((s, n) => s + n.matureCards, 0);
    return c.json({
      goal: { ...goal, _id: goal.id },
      nodes,
      overallMaturityRate: totalCards === 0 ? 0 : matureCards / totalCards,
    });
  });
}
