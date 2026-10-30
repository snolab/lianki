import { NextResponse } from "next/server";
import { dbBackend, getD1 } from "@/lib/d1";
import { handleSponsorsWebhook, type D1WithBatch } from "@/lib/payments/sponsors-store";

/**
 * GitHub Sponsors' webhook — pushed by GitHub, nothing polls. Register
 * https://lianki.com/api/payments/github-sponsors-webhook (content type JSON)
 * in the Sponsors dashboard → Webhooks; its secret is
 * GITHUB_SPONSORS_WEBHOOK_SECRET. Off (503) until that secret exists, and on
 * the Mongo backend. docs/payments.md, "GitHub Sponsors".
 */
export async function POST(req: Request) {
  const secret = dbBackend() === "d1" ? process.env.GITHUB_SPONSORS_WEBHOOK_SECRET?.trim() : "";
  // The signature covers the exact bytes, so read the raw text before parsing.
  const body = await req.text();
  const res = await handleSponsorsWebhook(
    {
      body,
      event: req.headers.get("x-github-event"),
      signature: req.headers.get("x-hub-signature-256"),
    },
    secret || undefined,
    () => getD1() as unknown as D1WithBatch,
  );
  if (res.body.status === "ignored") console.warn("[sponsors] ignored", res.body.reason);
  return NextResponse.json(res.body, { status: res.status });
}
