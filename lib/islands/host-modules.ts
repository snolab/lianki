/**
 * The page's own module instances, for remote islands (docs/dev-hot-islands.md).
 * Loaded only by loader.ts, so no page pays for it unless islands are hot.
 * Each import resolves to the instance the page already runs, so React,
 * the router, intlayer's context and the auth client are one and the same.
 */
import type { SharedModule } from "./rules";

export const HOST_MODULES: Record<SharedModule, () => Promise<unknown>> = {
  react: () => import("react"),
  "react-dom": () => import("react-dom"),
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  "next/link": () => import("next/link"),
  "next/navigation": () => import("next/navigation"),
  "next/image": () => import("next/image"),
  "next-intlayer": () => import("next-intlayer"),
  zod: () => import("zod"),
  "@/lib/auth-client": () => import("@/lib/auth-client"),
  "@/lib/debug-client": () => import("@/lib/debug-client"),
  "@/lib/dates": () => import("@/lib/dates"),
  "@/lib/app-locale": () => import("@/lib/app-locale"),
  "@/lib/islands/Island": () => import("./Island"),
  "@/lib/words/swipe-core": () => import("@/lib/words/swipe-core"),
};

/** Every shared module, as { [specifier]: namespace }. */
export async function loadHostModules(): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(HOST_MODULES).map(async ([k, load]) => [k, await load()] as const),
  );
  return Object.fromEntries(entries);
}
