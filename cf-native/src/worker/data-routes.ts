import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { stringify } from "yaml";
import {
  ApiTokensD1Repo,
  RoadmapGoalsD1Repo,
  PreferencesD1Repo,
  MembershipD1Repo,
} from "@/lib/repos/d1Repos";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { serializeNoteForExport, serializeGoalForExport, EXPORT_VERSION } from "@/lib/yaml-export";
import type { RoadmapGoal } from "@/types/roadmap";
import { resolveEmail, resolveUser, sha256 } from "./session";

// CF-native ports of the data API routes (token, preferences, membership,
// roadmap, export) — all reuse the extracted clean D1 repos. Faithful to the
// DB_BACKEND=d1 path of the Next routes.

// ── Membership orchestration (mirrors lib/membership.ts; MembershipD1Repo reused) ─
const TRIAL_DAYS = 90;
function tierFor(trialEndsAt?: Date, proEndsAt?: Date, now = new Date()): "free" | "trial" | "pro" {
  if (proEndsAt && proEndsAt > now) return "pro";
  if (trialEndsAt && trialEndsAt > now) return "trial";
  return "free";
}
async function getMembership(repo: MembershipD1Repo, userId: string) {
  const row = await repo.getUser(userId);
  if (!row) throw new Error("User not found");
  const trial = row.trialEndsAt ? new Date(row.trialEndsAt) : undefined;
  const pro = row.proEndsAt ? new Date(row.proEndsAt) : undefined;
  if (!trial && !pro) {
    const end = new Date();
    end.setDate(end.getDate() + TRIAL_DAYS);
    await repo.setTrial(userId, end);
    return { tier: "trial" as const, trialEndsAt: end, proEndsAt: undefined };
  }
  return { tier: tierFor(trial, pro), trialEndsAt: trial, proEndsAt: pro };
}

const RoadmapNodeSchema = z.object({
  id: z.string(),
  title: z.string().max(100),
  description: z.string().max(200),
  keywords: z.array(z.string().max(50)).min(1).max(8),
  order: z.number().int().min(0),
});
const SaveRoadmapSchema = z.object({
  topic: z.string().min(1).max(500),
  nodes: z.array(RoadmapNodeSchema).min(1).max(20),
});

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountDataRoutes(app: Hono<any>) {
  // ── API tokens (session-authed) ──────────────────────────────────────────────
  app.get("/api/token", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.json({ error: "Login required" }, 401);
    const tokens = await new ApiTokensD1Repo(c.env.DB).listByEmail(email);
    return c.json(tokens.map((t) => ({ id: t.tokenHash, name: t.name, createdAt: t.createdAt })));
  });
  app.post("/api/token", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.json({ error: "Login required" }, 401);
    const { name = "API Token" } = await c.req.json().catch(() => ({}));
    const token = "lk_" + randomBytes(32).toString("hex");
    await new ApiTokensD1Repo(c.env.DB).insert({
      tokenHash: sha256(token),
      email,
      name,
      createdAt: new Date(),
    });
    return c.json({ token }); // shown only once
  });
  app.delete("/api/token", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.json({ error: "Login required" }, 401);
    const id = new URL(c.req.raw.url).searchParams.get("id");
    if (!id) return c.json({ error: "missing id" }, 400);
    const repo = new ApiTokensD1Repo(c.env.DB);
    if ((await repo.emailByHash(id)) !== email) return c.json({ error: "not found" }, 404);
    await repo.delete(id);
    return c.json({ ok: true });
  });

  // ── Preferences (session-authed, keyed by user id) ───────────────────────────
  app.get("/api/preferences", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Login required" }, 401);
    const prefs = await new PreferencesD1Repo(c.env.DB, user.id).get();
    return c.json({ mobileExcludePatterns: prefs?.mobileExcludePatterns ?? [] });
  });
  app.post("/api/preferences", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Login required" }, 401);
    const body = await c.req.json();
    await new PreferencesD1Repo(c.env.DB, user.id).set(body.mobileExcludePatterns ?? []);
    return c.json({ success: true });
  });

  // ── Membership (session-authed) ──────────────────────────────────────────────
  app.get("/api/membership/status", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    try {
      const m = await getMembership(new MembershipD1Repo(c.env.DB), user.id);
      return c.json({
        tier: m.tier,
        trialEndsAt: m.trialEndsAt?.toISOString(),
        proEndsAt: m.proEndsAt?.toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: msg }, msg === "User not found" ? 404 : 500);
    }
  });
  app.post("/api/membership/start-trial", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Unauthorized" }, 401);
    try {
      const repo = new MembershipD1Repo(c.env.DB);
      const m = await getMembership(repo, user.id);
      if (m.trialEndsAt) return c.json({ error: "You have already used your trial" }, 400);
      if (m.tier === "pro") return c.json({ error: "You already have Pro membership" }, 400);
      const end = new Date();
      end.setDate(end.getDate() + TRIAL_DAYS);
      await repo.setTrial(user.id, end);
      return c.json({
        success: true,
        message: "Trial started! You now have 90 days of Pro access.",
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ── Roadmap goals (token-or-session authed) ──────────────────────────────────
  app.get("/api/roadmap", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.text("Unauthorized", 401);
    const goals = await new RoadmapGoalsD1Repo(c.env.DB, email).listAll();
    return c.json(goals.map((g) => ({ ...g, _id: g.id })));
  });
  app.post("/api/roadmap", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.text("Unauthorized", 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Invalid JSON", 400);
    }
    const parsed = SaveRoadmapSchema.safeParse(body);
    if (!parsed.success) return c.text(parsed.error.message, 400);
    const now = new Date();
    const goal: RoadmapGoal = { ...parsed.data, createdAt: now, updatedAt: now };
    const id = await new RoadmapGoalsD1Repo(c.env.DB, email).upsertByTopic(goal);
    return c.json({ _id: id, id, ...goal });
  });
  app.delete("/api/roadmap", async (c: any) => {
    const email = await resolveEmail(c.env, c.req.raw);
    if (!email) return c.text("Unauthorized", 401);
    const id = new URL(c.req.raw.url).searchParams.get("id");
    if (!id) return c.text("Missing id", 400);
    await new RoadmapGoalsD1Repo(c.env.DB, email).delete(id);
    return c.json({ ok: true });
  });

  // ── Export (YAML) — session-authed ───────────────────────────────────────────
  app.get("/api/export/yaml", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Login required" }, 401);
    const [notes, goals, prefs] = await Promise.all([
      new FsrsNotesD1Repo(c.env.DB, user.email).listAll(),
      new RoadmapGoalsD1Repo(c.env.DB, user.email).listAll(),
      new PreferencesD1Repo(c.env.DB, user.id).get(),
    ]);
    const data = {
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      email: user.email,
      fsrsNotes: notes.map((n) => serializeNoteForExport(n as unknown as Record<string, unknown>)),
      roadmapGoals: goals.map((g) =>
        serializeGoalForExport(g as unknown as Record<string, unknown>),
      ),
      preferences: { mobileExcludePatterns: prefs?.mobileExcludePatterns ?? [] },
    };
    const date = new Date().toISOString().slice(0, 10);
    return new Response(stringify(data), {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Content-Disposition": `attachment; filename="lianki-export-${date}.yaml"`,
      },
    });
  });
}
