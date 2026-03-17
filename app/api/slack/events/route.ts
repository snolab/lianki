/**
 * Slack Events API webhook for Lianki Bot
 *
 * Setup:
 *  1. Create a Slack App at https://api.slack.com/apps
 *  2. Enable "Event Subscriptions" → Request URL: https://www.lianki.com/api/slack/events
 *  3. Subscribe to bot events: message.channels
 *  4. Add env vars:
 *       SLACK_SIGNING_SECRET  — from Slack App > Basic Information > Signing Secret
 *       SLACK_BOT_EMAIL       — Lianki account email that receives notes from the channel
 */

import { createHmac, timingSafeEqual } from "crypto";
import { createEmptyCard } from "ts-fsrs";
import { db } from "@/app/db";
import { getFSRSNotesCollection } from "@/app/getFSRSNotesCollection";
import { normalizeUrl } from "@/lib/normalizeUrl";

export const dynamic = "force-dynamic";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";
const BOT_EMAIL = process.env.SLACK_BOT_EMAIL ?? "";

// Extract all http/https URLs from a Slack message text
function extractUrls(text: string): string[] {
  // Slack formats links as <url> or <url|label>
  const slackLinks = [...text.matchAll(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  // Also match bare URLs
  const bareUrls = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((m) => m[0]);
  const combined = [...new Set([...slackLinks, ...bareUrls])];
  return combined;
}

async function verifySlackSignature(req: Request, body: string): Promise<boolean> {
  if (!SIGNING_SECRET) return false;
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";
  // Reject requests older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const sigBase = `v0:${timestamp}:${body}`;
  const hmac = createHmac("sha256", SIGNING_SECRET).update(sigBase).digest("hex");
  const expected = `v0=${hmac}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function saveNoteForEmail(email: string, url: string, title?: string) {
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return; // skip un-normalizable URLs
  }
  const col = getFSRSNotesCollection(email);
  await col.updateOne(
    { url: normalized },
    {
      $setOnInsert: { card: createEmptyCard(), url: normalized },
      $set: { ...(title && { title }) },
    },
    { upsert: true },
  );
}

export async function POST(req: Request) {
  const body = await req.text();

  // Verify request authenticity
  const valid = await verifySlackSignature(req, body);
  if (!valid) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  // Slack URL verification challenge (one-time during setup)
  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") {
    return Response.json({ ok: true });
  }

  const event = payload.event as Record<string, unknown> | undefined;
  if (!event) return Response.json({ ok: true });

  // Only handle new user messages in channels (skip bot messages to avoid loops)
  if (event.type !== "message" || event.subtype || event.bot_id) {
    return Response.json({ ok: true });
  }

  const text = (event.text as string) ?? "";
  const urls = extractUrls(text);

  if (urls.length > 0 && BOT_EMAIL) {
    await Promise.allSettled(urls.map((url) => saveNoteForEmail(BOT_EMAIL, url)));
  }

  // Log to MongoDB for diagnostics (optional, non-blocking)
  try {
    await db.collection("SlackBotEvents").insertOne({
      ts: event.ts,
      channel: event.channel,
      urlsAdded: urls,
      email: BOT_EMAIL || null,
      createdAt: new Date(),
    });
  } catch {
    // non-fatal
  }

  return Response.json({ ok: true });
}
