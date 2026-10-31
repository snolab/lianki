/**
 * The contract every way of paying into the credit wallet implements. A
 * provider only has to start a payment and to recognise its own webhook; the
 * ledger, idempotency and the no-negative rule live in credits-store.ts, the
 * same for all of them. How to add one: docs/payments.md, "Adding a provider".
 */
export type ProviderId =
  | "stripe"
  | "komoju"
  | "payjp"
  | "paddle"
  | "usdt"
  | "afdian"
  | "patreon"
  | "github-sponsors";

export interface TopupUser {
  id: string;
  email?: string;
}

export interface TopupUrls {
  /** Where the provider sends the payer back after paying. */
  successUrl: string;
  /** …and after giving up. */
  cancelUrl: string;
}

/** How the page continues: follow a link, or show a QR code (crypto, some wallets). */
export type TopupStart =
  | { kind: "redirect"; url: string }
  | { kind: "qr"; qr: string; url?: string };

/** What a verified webhook says. Only `paid` credits the wallet. */
export type WebhookOutcome =
  | {
      status: "paid";
      /** The provider's id for this payment — with the provider id, the idempotency key. */
      paymentId: string;
      /** JPY actually paid (or the JPY value the provider settled). */
      amount: number;
      userId: string;
    }
  | { status: "ignored"; reason: string }
  | { status: "invalid" };

export interface PaymentProvider {
  id: ProviderId;
  /** Shown on /membership. */
  label: string;
  /** Payment methods shown under the label (brand names, not translated). */
  methods: string[];
  /**
   * `checkout`: the user tops up an amount they choose (createTopup).
   * `grant`: credits arrive from outside (a sponsorship, a membership on
   * another platform) — no button, only a webhook; credited as `sponsor`.
   */
  kind: "checkout" | "grant";
  /** Env vars / Worker secrets that must all be set for it to be enabled. */
  envKeys: string[];
  /** False for a reserved slot whose adapter is not written yet. */
  implemented: boolean;
  /** Start a top-up of `amount` JPY. Required for `checkout` providers. */
  createTopup?(amount: number, user: TopupUser, urls: TopupUrls): Promise<TopupStart>;
  /** Verify and read a webhook delivery. Must check the provider's signature. */
  verifyWebhook(req: Request): Promise<WebhookOutcome>;
}
