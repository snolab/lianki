import { NextRequest, NextResponse } from "next/server";
import {
  CONTACT_BODY_MAX,
  CONTACT_FIELD_MAX,
  CONTACT_GLOBAL,
  CONTACT_PER_IP,
  contactSlackText,
} from "@/lib/contact";
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
    return NextResponse.json({ error: "Name and email are required" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  if (
    name.length > CONTACT_FIELD_MAX ||
    email.length > CONTACT_FIELD_MAX ||
    str(phone).length > CONTACT_FIELD_MAX ||
    str(message).length > CONTACT_FIELD_MAX
  ) {
    return NextResponse.json({ error: "Input too long" }, { status: 400 });
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const text = contactSlackText({ name, email, phone: str(phone), message: str(message) });
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mrkdwn: false }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to send message" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
