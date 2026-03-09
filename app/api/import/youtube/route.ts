import { NextRequest, NextResponse } from "next/server";
import { authEmailOrToken } from "@/lib/authEmailOrToken";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { createEmptyCard } from "ts-fsrs";
import { normalizeUrl } from "@/lib/normalizeUrl";

export const dynamic = "force-dynamic";

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
    throw new Error(
      "YouTube API key not configured. Please set YOUTUBE_API_KEY environment variable.",
    );
  }

  const videos: string[] = [];
  let pageToken: string | undefined;

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
      const error = await response.json();
      throw new Error(error.error?.message || "Failed to fetch playlist from YouTube");
    }

    const data: YouTubePlaylistResponse = await response.json();

    for (const item of data.items) {
      const videoId = item.snippet.resourceId.videoId;
      videos.push(`https://www.youtube.com/watch?v=${videoId}`);
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return videos;
}

export async function POST(req: NextRequest) {
  try {
    const email = await authEmailOrToken(req);
    if (!email) {
      return NextResponse.json({ error: "Login required" }, { status: 401 });
    }

    const body = await req.json();
    const { playlistId } = body;

    if (!playlistId) {
      return NextResponse.json({ error: "Playlist ID is required" }, { status: 400 });
    }

    // Get YouTube API key from environment
    const apiKey = process.env.YOUTUBE_API_KEY;

    // Fetch all video URLs from the playlist
    const videoUrls = await fetchPlaylistVideos(playlistId, apiKey);

    if (videoUrls.length === 0) {
      return NextResponse.json({ error: "No videos found in playlist" }, { status: 404 });
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
    console.error("YouTube import error:", error);
    const message = error instanceof Error ? error.message : "Failed to import YouTube playlist";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
