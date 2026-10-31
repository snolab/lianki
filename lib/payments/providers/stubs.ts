/**
 * Reserved provider slots. Each names the secrets it will need, so the env
 * contract is fixed now; `implemented: false` keeps it off /membership even
 * when those secrets are set, until its adapter is written (see
 * docs/payments.md, "Adding a provider"). Replace a stub with a real module
 * next to stripe.ts and flip `implemented`.
 */
import type { PaymentProvider, ProviderId } from "./types";

function stub(p: Omit<PaymentProvider, "implemented" | "verifyWebhook">): PaymentProvider {
  return {
    ...p,
    implemented: false,
    async verifyWebhook() {
      return { status: "invalid" };
    },
  };
}

export const STUB_PROVIDERS: Record<Exclude<ProviderId, "stripe">, PaymentProvider> = {
  // KOMOJU (Degica): one hosted session for cards, Alipay, WeChat Pay, PayPay,
  // konbini and bank transfer. Konbini settles days later — credit on the
  // `payment.captured` webhook only.
  komoju: stub({
    id: "komoju",
    label: "KOMOJU",
    methods: ["Card", "Konbini", "PayPay", "Alipay", "WeChat Pay"],
    kind: "checkout",
    envKeys: ["KOMOJU_SECRET_KEY", "KOMOJU_WEBHOOK_SECRET"],
  }),
  // PAY.JP: charges must be created with three_d_secure (checkout-policy.ts).
  payjp: stub({
    id: "payjp",
    label: "PAY.JP",
    methods: ["Card"],
    kind: "checkout",
    envKeys: ["PAYJP_SECRET_KEY", "PAYJP_WEBHOOK_TOKEN"],
  }),
  // Paddle: merchant of record, settles in USD — credit the JPY price, not the
  // converted amount.
  paddle: stub({
    id: "paddle",
    label: "Paddle",
    methods: ["Card", "PayPal", "Apple Pay"],
    kind: "checkout",
    envKeys: ["PADDLE_API_KEY", "PADDLE_WEBHOOK_SECRET"],
  }),
  // A USDT (TRC-20 / ERC-20) gateway: shows a QR code (TopupStart kind "qr");
  // credit only after the gateway reports enough confirmations.
  usdt: stub({
    id: "usdt",
    label: "USDT",
    methods: ["USDT TRC-20", "USDT ERC-20"],
    kind: "checkout",
    envKeys: ["USDT_GATEWAY_API_KEY", "USDT_GATEWAY_WEBHOOK_SECRET"],
  }),
  // Grants: money arrives on another platform; its webhook credits `sponsor`.
  afdian: stub({
    id: "afdian",
    label: "爱发电 afdian",
    methods: ["Alipay", "WeChat Pay"],
    kind: "grant",
    envKeys: ["AFDIAN_USER_ID", "AFDIAN_API_TOKEN"],
  }),
  patreon: stub({
    id: "patreon",
    label: "Patreon",
    methods: ["Patreon"],
    kind: "grant",
    envKeys: ["PATREON_WEBHOOK_SECRET"],
  }),
  // GitHub Sponsors already grants Pro days (sponsors.ts); this slot is for
  // granting credits instead, should the owner prefer that.
  "github-sponsors": stub({
    id: "github-sponsors",
    label: "GitHub Sponsors",
    methods: ["GitHub Sponsors"],
    kind: "grant",
    envKeys: ["GITHUB_SPONSORS_CREDITS"],
  }),
};
