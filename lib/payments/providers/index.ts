/**
 * The provider registry. /membership lists `enabledProviders()` only: a
 * provider is enabled when it is implemented and every one of its `envKeys`
 * is set on the Worker.
 */
import { stripeProvider } from "./stripe";
import { STUB_PROVIDERS } from "./stubs";
import type { PaymentProvider } from "./types";

export type { PaymentProvider, ProviderId, TopupStart, WebhookOutcome } from "./types";

export const PROVIDERS: PaymentProvider[] = [stripeProvider, ...Object.values(STUB_PROVIDERS)];

export function providerEnabled(
  p: PaymentProvider,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return p.implemented && p.envKeys.every((k) => Boolean(env[k]?.trim()));
}

export function enabledProviders(env: Record<string, string | undefined> = process.env) {
  return PROVIDERS.filter((p) => providerEnabled(p, env));
}

export function providerFor(id: unknown): PaymentProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** What the page needs to render a provider choice. */
export function publicProvider(p: PaymentProvider) {
  return { id: p.id, label: p.label, methods: p.methods, kind: p.kind };
}
