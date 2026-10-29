/**
 * Turn a paid Checkout Session into Pro days. Called from the Stripe webhook,
 * which Stripe redelivers until it gets a 2xx, so this must be idempotent: the
 * `payment` row keyed by the session id is written in the same D1 batch
 * (one transaction) as the `proEndsAt` bump, and a session seen before is a
 * no-op.
 */
import type { D1Like, D1StmtLike } from "@/lib/d1/types";
import { extendedProEnd, passFor } from "./passes";

type D1WithBatch = D1Like & { batch(stmts: D1StmtLike[]): Promise<unknown> };

/** The fields of a Stripe Checkout Session this reads. */
export interface CheckoutSessionLike {
  id: string;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export type FulfilResult =
  | { status: "applied"; userId: string; proEndsAt: Date }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

export async function fulfilCheckout(
  d1: D1WithBatch,
  session: CheckoutSessionLike,
  now = new Date(),
): Promise<FulfilResult> {
  // Alipay and WeChat Pay settle before the redirect; anything still pending
  // arrives again as checkout.session.async_payment_succeeded.
  if (session.payment_status !== "paid") return { status: "ignored", reason: "not paid" };
  const pass = passFor(session.metadata?.passId);
  if (!pass) return { status: "ignored", reason: "unknown pass" };
  const userId = session.metadata?.userId || session.client_reference_id;
  if (!userId) return { status: "ignored", reason: "no user" };

  const seen = await d1.prepare("SELECT id FROM payment WHERE id = ?").bind(session.id).first();
  if (seen) return { status: "duplicate" };

  const user = await d1
    .prepare("SELECT proEndsAt FROM user WHERE id = ?")
    .bind(userId)
    .first<{ proEndsAt: string | null }>();
  if (!user) return { status: "ignored", reason: "user not found" };

  const current = user.proEndsAt ? new Date(user.proEndsAt) : undefined;
  const proEndsAt = extendedProEnd(current, pass.days, now);
  const at = now.toISOString();
  try {
    await d1.batch([
      d1
        .prepare(
          "INSERT INTO payment (id, userId, passId, days, amount, currency, proEndsAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          session.id,
          userId,
          pass.id,
          pass.days,
          session.amount_total ?? pass.amount,
          session.currency ?? pass.currency,
          proEndsAt.toISOString(),
          at,
        ),
      d1
        .prepare("UPDATE user SET proEndsAt = ?, updatedAt = ? WHERE id = ?")
        .bind(proEndsAt.toISOString(), at, userId),
    ]);
  } catch (e) {
    // Two deliveries racing past the SELECT: the primary key lets one through.
    if (/UNIQUE|PRIMARY KEY/i.test(String(e))) return { status: "duplicate" };
    throw e;
  }
  return { status: "applied", userId, proEndsAt };
}
