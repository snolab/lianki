import { NextRequest, NextResponse } from "next/server";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { createEmptyCard } from "ts-fsrs";
import { normalizeUrl } from "@/lib/normalizeUrl";
import { cappedJsonError, readJsonCapped, tooMany } from "@/lib/security/route-guard";
import { accountKey } from "@/lib/security/throttle";
import { logSanitizedError } from "@/lib/safeError";

/** Imports per account (D1): each one spends the shared YouTube API quota. */
const IMPORT_LIMIT = { max: 10, windowMs: 60 * 60_000 };
/** Pages of 50 read at most: 1000 videos. */
const MAX_PLAYLIST_PAGES = 20;
/** A YouTube playlist id: letters, digits, `-` and `_`. */
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

export const dynamic = "force-dynamic";

/** A failure with a code for the answer and a detail for the log only. */
class YoutubeImportError extends Error {
  constructor(
    readonly code: "not-configured" | "youtube-failed",
    detail: string,
  ) {
    super(detail);
  }
}

interface YouTubePlaylistItem {
  snippet: {
    resourceId: {
      videoId: string;
    };
    title: string;
  };
}

interface YouTubePlaylistResponse {
  items: YouTubePlaylistItem[];
  nextPageToken?: string;
}

async function fetchPlaylistVideos(playlistId: string, apiKey?: string): Promise<string[]> {
  if (!apiKey) {
    throw new YoutubeImportError("not-configured", "YOUTUBE_API_KEY is not set");
  }

  const videos: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", apiKey);
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      // Google's own message goes to the log, never into the answer.
      const error = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new YoutubeImportError(
        "youtube-failed",
        `YouTube ${response.status}: ${error?.error?.message ?? response.statusText}`,
      );
    }

    const data: YouTubePlaylistResponse = await response.json();

    for (const item of data.items) {
      const videoId = item.snippet.resourceId.videoId;
      videos.push(`https://www.youtube.com/watch?v=${videoId}`);
    }

    pageToken = data.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PLAYLIST_PAGES);

  return videos;
}

export async function POST(req: NextRequest) {
  try {
    const email = await authEmailOrToken(req);
    if (!email) {
      return NextResponse.json({ error: "login-required" }, { status: 401 });
    }

    const limited = await tooMany(await accountKey("import-youtube", email), IMPORT_LIMIT);
    if (limited) return limited;

    const body = await readJsonCapped(req, 4096);
    if (!body.ok) return cappedJsonError(body.status);
    const { playlistId } = (body.value ?? {}) as { playlistId?: unknown };

    if (!playlistId) {
      return NextResponse.json({ error: "playlist-id-required" }, { status: 400 });
    }
    if (typeof playlistId !== "string" || !PLAYLIST_ID.test(playlistId)) {
      return NextResponse.json({ error: "invalid-playlist-id" }, { status: 400 });
    }

    // Get YouTube API key from environment
    const apiKey = process.env.YOUTUBE_API_KEY;

    // Fetch all video URLs from the playlist
    const videoUrls = await fetchPlaylistVideos(playlistId, apiKey);

    if (videoUrls.length === 0) {
      return NextResponse.json({ error: "no-videos" }, { status: 404 });
    }

    // Import all videos into FSRS
    const FSRSNotes = getFSRSNotesCollection(email);

    const results = await Promise.allSettled(
      videoUrls.map(async (url) => {
        const normalized = normalizeUrl(url);
        return await FSRSNotes.findOneAndUpdate(
          { url: normalized },
          {
            $setOnInsert: { card: createEmptyCard(), url: normalized },
          },
          { upsert: true, returnDocument: "after" },
        );
      }),
    );

    const successful = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    return NextResponse.json({
      success: true,
      count: successful,
      failed,
      total: videoUrls.length,
      message: `Successfully imported ${successful} videos from YouTube playlist`,
    });
  } catch (error) {
    logSanitizedError("import.youtube", error);
    const code = error instanceof YoutubeImportError ? error.code : "failed";
    return NextResponse.json({ error: code }, { status: code === "youtube-failed" ? 502 : 500 });
  }
}
