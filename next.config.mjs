import { withIntlayer } from "next-intlayer/server";

/** @type {import('next').NextConfig} */
const nextConfig = {
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
  // Serve userscript as text/plain so browsers navigate to it (required for
  // Tampermonkey/Violentmonkey to intercept and show the install dialog)
  headers: async () => [
    {
      source: "/:file(.*\\.user\\.js)",
      headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
    },
  ],
};

export default withIntlayer(nextConfig);
