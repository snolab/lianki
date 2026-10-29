import { withIntlayer } from "next-intlayer/server";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Which build this is, inlined into server and client alike: a page whose
  // id differs from the one lianki-push announces is out of date (workers/push;
  // CI publishes this same value after each deploy).
  env: {
    NEXT_PUBLIC_BUILD_ID: (process.env.GITHUB_SHA ?? `local-${Date.now()}`).slice(0, 20),
  },
  // Internal workspace package shipping TypeScript source (@lianki/core).
  transpilePackages: ["@lianki/core"],
  async headers() {
    return [
      {
        source: "/:file(lianki.user.js|lianki.meta.js)",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
  // @better-auth/kysely-adapter eagerly imports `node:sqlite` (for a dialect
  // Lianki never uses — D1 mode uses kysely-d1). node:sqlite is unavailable in
  // the Workers runtime and unbundlable by Turbopack, so alias it to a stub.
  //
  // CF_BUILD=1 (the Cloudflare build) additionally stubs the `mongodb` driver:
  // the deployed Worker always runs DB_BACKEND=d1, so the driver is dead weight
  // (~1 MiB gzipped). Local `next dev` keeps the real driver for MongoDB mode.
  turbopack: {
    resolveAlias: {
      "node:sqlite": "./lib/stubs/node-sqlite.js",
      ...(process.env.CF_BUILD === "1" ? { mongodb: "./lib/stubs/mongodb.js" } : {}),
    },
  },
  // We use oxlint instead of ESLint — skip Next.js's built-in lint pass
  eslint: { ignoreDuringBuilds: true },
  // Type-checking is handled by the IDE / tsc --noEmit; skip during build
  typescript: { ignoreBuildErrors: true },
  // Allow Google user profile images for avatar display
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
  // Serve userscript with headers required for Tampermonkey/Violentmonkey/ScriptCat install dialog.
  // Content-Disposition must not include filename= — some browsers trigger a download if it does.
  // NOTE: this used to be a second `headers` key alongside an earlier one; the duplicate silently
  // won and dropped the Cache-Control rule, so both rules now live here.
  headers: async () => [
    {
      source: "/:file(.*\\.user\\.js)",
      headers: [
        { key: "Content-Type", value: "text/plain; charset=utf-8" },
        { key: "Content-Disposition", value: "inline" },
      ],
    },
    {
      source: "/:file(lianki.user.js|lianki.meta.js)",
      headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
    },
  ],
};

// `next dev` has no Cloudflare runtime, so `getCloudflareContext()` — which
// every D1 query goes through (lib/d1/index.ts) — throws without this. It hands
// the dev server miniflare-backed bindings from wrangler.jsonc, so DB_BACKEND=d1
// works locally against `.wrangler/state` instead of only inside the deployed
// Worker. Before this, local dev only ran on MongoDB, which no longer exists.
//
// Dev only, and awaited lazily: in a production build the import is dead weight,
// and at module scope it would run during `next build` too.
if (process.env.NODE_ENV === "development") {
  const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
  await initOpenNextCloudflareForDev();
}

export default withIntlayer(nextConfig);
