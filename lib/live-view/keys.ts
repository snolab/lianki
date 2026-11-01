/**
 * The public keys whose live-view pointers lianki.com and the page trust
 * (lib/live-view/rules.ts, docs/live-view.md). Raw Ed25519, 32 bytes,
 * base64url. Public, so it is committed here, reviewed like code, and the
 * same in the Worker and the browser bundle — no Worker var, no secret.
 *
 * The private half is on the owner's Mac only (~/.config/lianki/live-view-key.json,
 * made by `bun scripts/dev/live-view.ts keygen`). To rotate: keygen a new pair,
 * add its key here, deploy, then drop the old one.
 */
export const LIVE_VIEW_PUBLIC_KEYS: readonly string[] = [
  // snomiao's Mac, 2026-11-01
  "_V2ZelxrMlkmnp6Y0XL-TI_GSU3haKmAoTIiWhkGho0",
];

/**
 * The keys this build trusts. A dev build (next dev, tests) may add one with
 * NEXT_PUBLIC_LIVE_VIEW_TEST_KEY, so local QA never needs the real private
 * key; a production build ignores it.
 */
export function trustedLiveViewKeys(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  testKey: string | undefined = process.env.NEXT_PUBLIC_LIVE_VIEW_TEST_KEY,
): string[] {
  const keys = [...LIVE_VIEW_PUBLIC_KEYS];
  if (nodeEnv !== "production" && testKey?.trim()) keys.push(testKey.trim());
  return keys;
}

let imported: Promise<CryptoKey[]> | null = null;

/** The trusted keys as CryptoKeys, imported once. */
export function liveViewKeys(): Promise<CryptoKey[]> {
  imported ??= import("./rules").then(async ({ importLiveViewPublicKey }) => {
    const out: CryptoKey[] = [];
    for (const k of trustedLiveViewKeys())
      try {
        out.push(await importLiveViewPublicKey(k));
      } catch {}
    return out;
  });
  return imported;
}
