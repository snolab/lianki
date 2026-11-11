import { NextRequest, NextResponse } from "next/server";
import { CONTACT_BODY_MAX, CONTACT_GLOBAL, CONTACT_PER_IP, contactSlackText } from "@/lib/contact";
import { cfg } from "@/lib/config-store";
import { cappedJsonError, clientIp, readJsonCapped, tooMany } from "@/lib/security/route-guard";

export async function POST(req: NextRequest) {
  const limited =
    (await tooMany(`contact:ip:${clientIp(req.headers)}`, CONTACT_PER_IP)) ??
    (await tooMany("contact:global", CONTACT_GLOBAL));
  if (limited) return limited;

  const body = await readJsonCapped(req, CONTACT_BODY_MAX);
  if (!body.ok) return cappedJsonError(body.status);
  const { name, email, phone, message } = (body.value ?? {}) as Record<string, unknown>;

  if (!name || !email || typeof name !== "string" || typeof email !== "string") {
    return NextResponse.json({ error: "name-and-email-required" }, { status: 400 });
  }
  // Config `contact.fieldMax` (lib/config.ts, docs/config-store.md).
  const max = await cfg("contact.fieldMax");
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  if (
    name.length > max ||
    email.length > max ||
    str(phone).length > max ||
    str(message).length > max
  ) {
    return NextResponse.json({ error: "too-long" }, { status: 400 });
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json({ error: "not-configured" }, { status: 500 });
  }

  const text = contactSlackText({ name, email, phone: str(phone), message: str(message) });
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mrkdwn: false, unfurl_links: false, unfurl_media: false }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "send-failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
