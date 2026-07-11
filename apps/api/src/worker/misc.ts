import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createEmptyCard } from "ts-fsrs";
import { FsrsNotesD1Repo } from "@/lib/repos/fsrsNotesD1";
import { normalizeUrl } from "@/lib/normalizeUrl";
import { newServerHLC } from "@/app/fsrs-helpers";
import type { D1Like } from "@/lib/d1/types";

// CF-native ports of the contact form + Slack events webhook.

const MAX_LEN = 2000;

function extractUrls(text: string): string[] {
  const slackLinks = [...text.matchAll(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const bareUrls = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((m) => m[0]);
  return [...new Set([...slackLinks, ...bareUrls])];
}

async function verifySlackSignature(
  signingSecret: string,
  headers: Headers,
  body: string,
): Promise<boolean> {
  if (!signingSecret) return false;
  const timestamp = headers.get("x-slack-request-timestamp") ?? "";
  const signature = headers.get("x-slack-signature") ?? "";
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const hmac = createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(`v0=${hmac}`));
  } catch {
    return false;
  }
}

/** Insert the URL as a card for `email` if not already present (preserve state). */
async function saveNoteForEmail(db: D1Like, email: string, url: string, title?: string) {
  let normalized: string;
  try {
    normalized = normalizeUrl(url);
  } catch {
    return;
  }
  const repo = new FsrsNotesD1Repo(db, email);
  const existing = await repo.getByUrl(normalized);
  if (existing) {
    if (title && existing.title !== title) {
      const { id, ...note } = existing;
      await repo.upsert({ ...note, title }, id);
    }
    return;
  }
  await repo.upsert({
    url: normalized,
    card: createEmptyCard(),
    hlc: newServerHLC(),
    log: [],
    ...(title ? { title } : {}),
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function mountMiscRoutes(app: Hono<any>) {
  // ── Contact form → Slack webhook ─────────────────────────────────────────────
  app.post("/api/contact", async (c: any) => {
    const { name, email, phone, message } = await c.req.json().catch(() => ({}));
    if (!name || !email) return c.json({ error: "Name and email are required" }, 400);
    if ([name, email, phone, message].some((v) => String(v ?? "").length > MAX_LEN))
      return c.json({ error: "Input too long" }, 400);

    const webhookUrl = c.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) return c.json({ error: "Webhook not configured" }, 500);

    const text = [
      "*New Contact from Lianki*",
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone || "N/A"}`,
      `Message: ${message || "N/A"}`,
    ].join("\n");
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return c.json({ error: "Failed to send message" }, 500);
    return c.json({ ok: true });
  });

  // ── Slack Events API webhook (saves posted URLs as cards) ────────────────────
  app.post("/api/slack/events", async (c: any) => {
    const body = await c.req.raw.text();
    if (!(await verifySlackSignature(c.env.SLACK_SIGNING_SECRET ?? "", c.req.raw.headers, body)))
      return c.json({ error: "invalid signature" }, 401);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });
    if (payload.type !== "event_callback") return c.json({ ok: true });

    const event = payload.event as Record<string, unknown> | undefined;
    if (!event || event.type !== "message" || event.subtype || event.bot_id)
      return c.json({ ok: true });

    const botEmail = c.env.SLACK_BOT_EMAIL ?? "";
    const urls = extractUrls((event.text as string) ?? "");
    if (urls.length > 0 && botEmail) {
      await Promise.allSettled(
        urls.map((url) => saveNoteForEmail(c.env.DB as D1Like, botEmail, url)),
      );
      console.log(
        `[slack] ts=${event.ts} channel=${event.channel} urlsAdded=${urls.length} email=${botEmail}`,
      );
    }
    return c.json({ ok: true });
  });
}
