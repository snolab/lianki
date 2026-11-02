/**
 * The provider registry. /membership lists `providersFor(email)` only: a
 * provider is enabled when it is implemented, every one of its `envKeys` is
 * set on the Worker and its mode is not off; a test-mode provider is shown to
 * the owner alone.
 */
import { isOwner } from "@/lib/owner";
import { komojuProvider } from "./komoju";
import { stripeProvider } from "./stripe";
import { STUB_PROVIDERS } from "./stubs";
import type { PaymentProvider, ProviderMode } from "./types";

export type {
  PaymentProvider,
  ProviderId,
  ProviderMode,
  TopupStart,
  WebhookOutcome,
} from "./types";

export const PROVIDERS: PaymentProvider[] = [
  stripeProvider,
  komojuProvider,
  ...Object.values(STUB_PROVIDERS),
];

type Env = Record<string, string | undefined>;

/** Test or live; null when the provider is off. */
export function providerMode(p: PaymentProvider, env: Env = process.env): ProviderMode | null {
  if (!p.implemented || !p.envKeys.every((k) => Boolean(env[k]?.trim()))) return null;
  return p.mode ? p.mode(env) : "live";
}

export function providerEnabled(p: PaymentProvider, env: Env = process.env): boolean {
  return providerMode(p, env) !== null;
}

/** Whether `email` may pay through `p`: live for everyone, test for the owner only. */
export function providerOpenTo(
  p: PaymentProvider,
  email: string | null | undefined,
  env: Env = process.env,
): boolean {
  const mode = providerMode(p, env);
  return mode === "live" || (mode === "test" && isOwner(email, env.OWNER_EMAILS));
}

export function enabledProviders(env: Env = process.env) {
  return PROVIDERS.filter((p) => providerEnabled(p, env));
}

/** The providers `email` may pay through. */
export function providersFor(email: string | null | undefined, env: Env = process.env) {
  return PROVIDERS.filter((p) => providerOpenTo(p, email, env));
}

export function providerFor(id: unknown): PaymentProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** What the page needs to render a provider choice. */
export function publicProvider(p: PaymentProvider, env: Env = process.env) {
  return {
    id: p.id,
    label: providerMode(p, env) === "test" ? `${p.label} (test)` : p.label,
    methods: p.methods,
    kind: p.kind,
  };
}
