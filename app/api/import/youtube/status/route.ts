import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Check if YouTube API key is configured
 * Returns { available: boolean }
 */
export async function GET() {
  const apiKey = process.env.YOUTUBE_API_KEY;
  return NextResponse.json({
    available: !!apiKey,
  });
}
