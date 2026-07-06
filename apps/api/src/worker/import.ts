import { Hono } from "hono";
import { parse } from "yaml";
import { z } from "zod";
import { createEmptyCard } from "ts-fsrs";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { RoadmapGoalsD1Repo, PreferencesD1Repo } from "@/lib/repos/d1Repos";
import { restoreNoteFromExport, restoreGoalFromExport, EXPORT_VERSION } from "@/lib/yaml-export";
import { newServerHLC } from "@/app/fsrs-helpers";
import { normalizeUrl } from "@/lib/normalizeUrl";
import { logSanitizedError } from "@/lib/safeError";
import type { FSRSNote } from "@/lib/core/fsrsNote";
import type { RoadmapGoal } from "@/types/roadmap";
import type { FilterPattern } from "@/lib/core/preferences";
import type { D1Like } from "@/lib/d1/types";
import { resolveEmail, resolveUser } from "./session";

// CF-native ports of the import routes (yaml restore, youtube playlist,
// anki-client). Reuse the clean D1 repos + yaml-export. Server-side .apkg
// parsing (import/anki) is deferred — it needs the apkg-parser on Workers.

const zExport = z.object({
  version: z.string(),
  email: z.string(),
  fsrsNotes: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  roadmapGoals: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  preferences: z.object({ mobileExcludePatterns: z.array(z.unknown()).optional() }).optional(),
});

const zAnkiBody = z.object({
  cards: z
    .array(z.object({ url: z.string(), title: z.string(), notes: z.string().optional() }))
    .max(200),
});

/** Insert only if the url isn't already a card (preserves existing review state). */
async function insertIfNew(repo: FsrsNotesD1Repo, note: FSRSNote): Promise<boolean> {
  if (await repo.getByUrl(note.url)) return false;
  await repo.upsert(note);
  return true;
}

async function fetchPlaylistVideos(playlistId: string, apiKey?: string): Promise<string[]> {
  if (!apiKey)
    throw new Error(
      "YouTube API key not configured. Please set YOUTUBE_API_KEY environment variable.",
    );
  const videos: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url.toString());
    if (!response.ok) {
      const err = (await response.json()) as { error?: { message?: string } };
      throw new Error(err.error?.message || "Failed to fetch playlist from YouTube");
    }
    const data = (await response.json()) as {
      items: { snippet: { resourceId: { videoId: string } } }[];
      nextPageToken?: string;
    };
    for (const item of data.items)
      videos.push(`https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return videos;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountImportRoutes(app: Hono<any>) {
  // ── YAML restore (session-authed) ────────────────────────────────────────────
  app.post("/api/import/yaml", async (c: any) => {
    const user = await resolveUser(c.env, c.req.raw);
    if (!user) return c.json({ error: "Login required" }, 401);

    let text: string;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const form = await c.req.raw.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return c.json({ error: "Missing file field" }, 400);
      text = await file.text();
    } else {
      text = await c.req.raw.text();
    }

    let parsed: unknown;
    try {
      parsed = parse(text);
    } catch {
      return c.json({ error: "Invalid YAML" }, 400);
    }
    const result = zExport.safeParse(parsed);
    if (!result.success)
      return c.json({ error: "Invalid export format", details: result.error.flatten() }, 400);
    const data = result.data;
    if (data.version !== EXPORT_VERSION)
      return c.json({ error: `Unsupported version: ${data.version}` }, 400);

    const db = c.env.DB as D1Like;
    let notesUpserted = 0;
    let goalsUpserted = 0;
    const notesRepo = new FsrsNotesD1Repo(db, user.email);
    for (const raw of data.fsrsNotes) {
      if (typeof raw.url !== "string" || !raw.url) continue;
      const note = restoreNoteFromExport(raw) as unknown as FSRSNote;
      await notesRepo.upsert(note, typeof raw.id === "string" ? raw.id : undefined);
      notesUpserted++;
    }
    const goalsRepo = new RoadmapGoalsD1Repo(db, user.email);
    for (const raw of data.roadmapGoals) {
      if (typeof raw.topic !== "string" || !raw.topic) continue;
      await goalsRepo.upsertByTopic(
        restoreGoalFromExport(raw) as unknown as RoadmapGoal & { id?: string },
      );
      goalsUpserted++;
    }
    if (data.preferences) {
      await new PreferencesD1Repo(db, user.id).set(
        (data.preferences.mobileExcludePatterns ?? []) as FilterPattern[],
      );
    }
    return c.json({
      ok: true,
      notesUpserted,
      goalsUpserted,
      preferencesRestored: !!data.preferences,
    });
  });

  // ── YouTube playlist import (token-or-session) ───────────────────────────────
  app.get("/api/import/youtube/status", (c: any) => c.json({ available: !!c.env.YOUTUBE_API_KEY }));

  app.post("/api/import/youtube", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Login required" }, 401);
      const { playlistId } = await c.req.json();
      if (!playlistId) return c.json({ error: "Playlist ID is required" }, 400);

      const videoUrls = await fetchPlaylistVideos(playlistId, c.env.YOUTUBE_API_KEY);
      if (videoUrls.length === 0) return c.json({ error: "No videos found in playlist" }, 404);

      const repo = new FsrsNotesD1Repo(c.env.DB as D1Like, email);
      const results = await Promise.allSettled(
        videoUrls.map((url) =>
          insertIfNew(repo, { url: normalizeUrl(url), card: createEmptyCard(), log: [] }),
        ),
      );
      const successful = results.filter((r) => r.status === "fulfilled").length;
      return c.json({
        success: true,
        count: successful,
        failed: results.length - successful,
        total: videoUrls.length,
        message: `Successfully imported ${successful} videos from YouTube playlist`,
      });
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : "Failed to import YouTube playlist" },
        500,
      );
    }
  });

  // ── Anki (client-parsed cards) ───────────────────────────────────────────────
  app.post("/api/import/anki-client", async (c: any) => {
    try {
      const email = await resolveEmail(c.env, c.req.raw);
      if (!email) return c.json({ error: "Authentication required" }, 401);
      const { cards } = zAnkiBody.parse(await c.req.json());
      const repo = new FsrsNotesD1Repo(c.env.DB as D1Like, email);
      let imported = 0;
      let skipped = 0;
      for (const card of cards) {
        const ok = await insertIfNew(repo, {
          url: card.url,
          title: card.title,
          card: createEmptyCard(),
          hlc: newServerHLC(),
          log: [],
          notes: card.notes ?? "",
        }).catch(() => false);
        if (ok) imported++;
        else skipped++;
      }
      return c.json({ imported, skipped });
    } catch (e) {
      logSanitizedError("import.anki-client", e);
      return c.json({ error: "Import failed" }, 500);
    }
  });
}
