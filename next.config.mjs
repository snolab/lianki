import { withIntlayer } from "next-intlayer/server";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // We use oxlint instead of ESLint — skip Next.js's built-in lint pass
  eslint: { ignoreDuringBuilds: true },
  // Type-checking is handled by the IDE / tsc --noEmit; skip during build
  typescript: { ignoreBuildErrors: true },
};

export default withIntlayer(nextConfig);
