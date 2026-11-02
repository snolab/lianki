import { withIntlayer } from "next-intlayer/server";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The whole-page dev server (docs/dev-whole-page.md) is opened on its LAN
  // address; next dev refuses dev assets to other origins unless listed.
  ...(process.env.LIANKI_DEV_WHOLE_PAGE === "1" && process.env.BETTER_AUTH_BASE_URL
    ? { allowedDevOrigins: [new URL(process.env.BETTER_AUTH_BASE_URL).hostname] }
    : {}),
  // Which build this is, inlined into server and client alike: a page whose
  // id differs from the one lianki-push announces is out of date (workers/push;
  // CI publishes this same value after each deploy).
  env: {
    NEXT_PUBLIC_BUILD_ID: (process.env.GITHUB_SHA ?? `local-${Date.now()}`).slice(0, 20),
  },
  // Internal workspace package shipping TypeScript source (@lianki/core).
  transpilePackages: ["@lianki/core", "@lianki/debug-chat", "@lianki/ui-state"],
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
    // The Learning Partner's frame (docs/dev-debug-widget.md, "The frame"): the one
    // route any site may frame. It holds no session; it connects only with a
    // ticket the userscript hands it over a MessagePort.
    {
      source: "/embed/partner",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors *" },
        { key: "Cache-Control", value: "no-store" },
      ],
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
  // The whole-page dev server (scripts/dev/whole-page.ts, docs/dev-whole-page.md)
  // swaps in a config whose D1 and R2 are the REMOTE production ones; its guard
  // proxy is what keeps that owner-only.
  await initOpenNextCloudflareForDev(
    process.env.LIANKI_DEV_WHOLE_PAGE === "1"
      ? { configPath: "wrangler.dev-whole-page.jsonc", remoteBindings: true }
      : undefined,
  );
}

export default withIntlayer(nextConfig);
