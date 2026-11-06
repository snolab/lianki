/**
 * KOMOJU (Degica): one hosted session for cards, konbini, PayPay, Alipay and
 * WeChat Pay. Plain fetch + Web Crypto, no SDK.
 *
 * Mode is decided by the server's own settings, never by a request: the key's
 * own prefix and the owner's `payments.komoju.live` feature flag (lib/flags.ts,
 * toggled at /dev/flags, no deploy).
 *
 * - **test**: an `sk_test_…` key and the flag off. Only the owner
 *   (`site_role`) is offered it, and its webhook credits only the owner —
 *   a test card must never become real credits for anyone else.
 * - **live**: an `sk_live_…` key and the flag on. Offered to everyone.
 * - **off**: a secret is missing, the key disagrees with the flag (a live key
 *   with the flag off: no test mode on a live key), the flag cannot be read,
 *   or the key does not prove the mode (KOMOJU has no API field that says
 *   which mode a key is in, so any other format is refused).
 *
 * The flag gates STARTING a payment only. The webhook settles by
 * `komojuKeyMode` (the key alone): the payment it credits is re-read from the
 * API with the live key, so it is real money, on a session this server created
 * — which it only does while the flag is on. A konbini payment started before
 * the kill switch and paid days after it is therefore still credited.
 *
 * The webhook is only a hint: a signed `payment.captured` is re-read from the
 * KOMOJU API with the secret key, and the amount, currency, status and user are
 * taken from that answer (and from the session this server created), never
 * from the webhook body or the client. docs/payments.md, "KOMOJU".
 */
import { flagIn, type FlagValues } from "@/lib/flags";
import { hmacSha256Hex, timingSafeEqual } from "../stripe";
import { topupName } from "../credits";
import type { PaymentProvider, ProviderMode, WebhookOutcome } from "./types";

const API = "https://komoju.com/api/v1";

type Env = Record<string, string | undefined>;

/** What the configured key proves on its own (the webhook settles by this). */
export function komojuKeyMode(env: Env = process.env): ProviderMode | null {
  const key = env.KOMOJU_SECRET_KEY?.trim();
  if (!key || !env.KOMOJU_WEBHOOK_SECRET?.trim()) return null;
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return null;
}

/**
 * Whether a KOMOJU payment may start, and in which mode. Fail closed: the mode
 * must be proven by the key's own format AND agree with the flag. KOMOJU
 * decides test/live by the key alone and exposes no mode field, so an
 * unrecognised key (e.g. a non-prefixed one) is off — no session, no credit —
 * rather than guessed.
 */
export function komojuMode(env: Env = process.env, flags: FlagValues = {}): ProviderMode | null {
  const key = komojuKeyMode(env);
  const live = flagIn(flags, "payments.komoju.live");
  if (key === "live") return live ? "live" : null;
  if (key === "test") return live ? null : "test";
  return null;
}

function authHeader(): string {
  return `Basic ${btoa(`${process.env.KOMOJU_SECRET_KEY!.trim()}:`)}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  // A throw becomes a 500 at the webhook, so KOMOJU retries the delivery.
  if (!res.ok)
    throw new Error(`KOMOJU ${path} failed (${res.status}): ${data.error?.message ?? ""}`);
  return data;
}

interface KomojuPayment {
  id: string;
  status: string;
  amount: number;
  currency: string;
  /** The session id (or the session) the payment came from. */
  session?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
  amount_refunded?: number;
}

interface KomojuSession {
  id: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string> | null;
}

/** The session parameters for a top-up (exported for tests). */
export function sessionParams(
  amount: number,
  userId: string,
  email: string | undefined,
  returnUrl: string,
) {
  return {
    amount,
    currency: "JPY",
    return_url: returnUrl,
    email,
    // Read back from the API (not the webhook) when the payment is captured.
    metadata: { userId, kind: "topup", amount: String(amount), item: topupName(amount) },
  };
}

/** Who to credit and how much, from what the API says — or why not. */
export function topupFromPayment(p: KomojuPayment, s: KomojuSession | null): WebhookOutcome {
  if (p.status !== "captured") return { status: "ignored", reason: `status ${p.status}` };
  if (String(p.currency).toUpperCase() !== "JPY") return { status: "ignored", reason: "not JPY" };
  // `amount`, not `total`: total adds the konbini fee the payer covers.
  const amount = Number(p.amount);
  if (!Number.isInteger(amount) || amount <= 0) return { status: "ignored", reason: "no amount" };
  const meta = s?.metadata ?? p.metadata ?? null;
  if (meta?.kind !== "topup" || !meta.userId) return { status: "ignored", reason: "not a top-up" };
  // The session this server created must agree with what was paid.
  if (Number(meta.amount) !== amount) return { status: "ignored", reason: "amount mismatch" };
  if (s && (Number(s.amount) !== amount || String(s.currency).toUpperCase() !== "JPY"))
    return { status: "ignored", reason: "session mismatch" };
  return { status: "paid", paymentId: p.id, amount, userId: meta.userId };
}

function sessionId(p: KomojuPayment): string | null {
  const s = p.session;
  if (typeof s === "string") return s || null;
  return s?.id ?? null;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const komojuProvider: PaymentProvider = {
  id: "komoju",
  label: "KOMOJU",
  methods: ["Card", "Konbini", "PayPay", "Alipay", "WeChat Pay"],
  kind: "checkout",
  envKeys: ["KOMOJU_SECRET_KEY", "KOMOJU_WEBHOOK_SECRET"],
  implemented: true,
  mode: komojuMode,
  keyMode: komojuKeyMode,
  async createTopup(amount, user, urls, mode) {
    // The key itself must still be in the mode the caller decided.
    if (komojuKeyMode() !== mode) throw new Error("KOMOJU is off");
    const s = await api<{ session_url?: string }>("/sessions", {
      method: "POST",
      body: JSON.stringify(sessionParams(amount, user.id, user.email, urls.successUrl)),
    });
    if (!s.session_url) throw new Error("KOMOJU session has no session_url");
    return { kind: "redirect", url: s.session_url };
  },
  async verifyWebhook(req) {
    // Settled by the key alone (see the top of this file).
    if (!komojuKeyMode()) return { status: "invalid" };
    const body = await req.text();
    const sig = req.headers.get("x-komoju-signature")?.trim().toLowerCase() ?? "";
    const want = await hmacSha256Hex(process.env.KOMOJU_WEBHOOK_SECRET!.trim(), body);
    if (!sig || !timingSafeEqual(want, sig)) return { status: "invalid" };

    let event: { type?: string; data?: { id?: unknown } };
    try {
      event = JSON.parse(body);
    } catch {
      return { status: "invalid" };
    }
    const id = event.data?.id;
    const type = String(event.type ?? "");
    if (type !== "payment.captured" && type !== "payment.refunded")
      return { status: "ignored", reason: type || "no type" };
    if (typeof id !== "string" || !SAFE_ID.test(id)) return { status: "ignored", reason: "no id" };

    // Re-read the payment: the API is the truth, the webhook only says "look".
    const p = await api<KomojuPayment>(`/payments/${id}`);
    if (type === "payment.refunded") {
      // Full refunds only (KOMOJU's payment.refunded); a partial refund
      // (payment.refund.created) is settled by hand at /dev/credits.
      return p.status === "refunded"
        ? { status: "refunded", paymentId: p.id }
        : { status: "ignored", reason: `status ${p.status}` };
    }
    const sid = sessionId(p);
    const s = sid && SAFE_ID.test(sid) ? await api<KomojuSession>(`/sessions/${sid}`) : null;
    return topupFromPayment(p, s);
  },
};
