/**
 * The provider registry. /membership lists `providersFor(email)` only: a
 * provider is enabled when it is implemented, every one of its `envKeys` is
 * set on the Worker and its mode is not off; a test-mode provider is shown to
 * the owner alone.
 */
import type { FlagValues } from "@/lib/flags";
import { isAdmin } from "@/lib/permissions";
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

function configured(p: PaymentProvider, env: Env): boolean {
  return p.implemented && p.envKeys.every((k) => Boolean(env[k]?.trim()));
}

/**
 * Whether a payment through `p` may START, test or live; null when off.
 * `flags` is a `readFlags()` snapshot (lib/flags-store.ts); a missing flag is
 * off, so a live provider needs its live flag on.
 */
export function providerMode(
  p: PaymentProvider,
  env: Env = process.env,
  flags: FlagValues = {},
): ProviderMode | null {
  if (!configured(p, env)) return null;
  return p.mode ? p.mode(env, flags) : "live";
}

/**
 * The mode `p`'s webhook settles in: the key alone, flags ignored, so a
 * payment started while live was on is credited after it is turned off.
 */
export function providerSettleMode(
  p: PaymentProvider,
  env: Env = process.env,
): ProviderMode | null {
  if (!configured(p, env)) return null;
  if (p.keyMode) return p.keyMode(env);
  return p.mode ? p.mode(env) : "live";
}

export function providerEnabled(
  p: PaymentProvider,
  env: Env = process.env,
  flags: FlagValues = {},
): boolean {
  return providerMode(p, env, flags) !== null;
}

/** Whether `email` may pay through `p`: live for everyone, test for the owner only. */
export function providerOpenTo(
  p: PaymentProvider,
  email: string | null | undefined,
  env: Env = process.env,
  flags: FlagValues = {},
): boolean {
  const mode = providerMode(p, env, flags);
  return mode === "live" || (mode === "test" && isAdmin(email));
}

export function enabledProviders(env: Env = process.env, flags: FlagValues = {}) {
  return PROVIDERS.filter((p) => providerEnabled(p, env, flags));
}

/** The providers `email` may pay through. */
export function providersFor(
  email: string | null | undefined,
  env: Env = process.env,
  flags: FlagValues = {},
) {
  return PROVIDERS.filter((p) => providerOpenTo(p, email, env, flags));
}

export function providerFor(id: unknown): PaymentProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** What the page needs to render a provider choice. */
export function publicProvider(p: PaymentProvider, env: Env = process.env, flags: FlagValues = {}) {
  return {
    id: p.id,
    label: providerMode(p, env, flags) === "test" ? `${p.label} (test)` : p.label,
    methods: p.methods,
    kind: p.kind,
  };
}
