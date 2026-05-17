import { withIntlayer } from "next-intlayer/server";

/** @type {import('next').NextConfig} */
const nextConfig = {
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
  turbopack: {
    resolveAlias: {
      "node:sqlite": "./lib/stubs/node-sqlite.js",
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
  // Serve userscript with headers required for Tampermonkey/Violentmonkey install dialog.
  // Content-Disposition must not include filename= — some browsers trigger a download if it does.
  headers: async () => [
    {
      source: "/:file(.*\\.user\\.js)",
      headers: [
        { key: "Content-Type", value: "text/plain; charset=utf-8" },
        { key: "Content-Disposition", value: "inline" },
      ],
    },
  ],
};

export default withIntlayer(nextConfig);
