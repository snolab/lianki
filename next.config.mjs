/** @type {import('next').NextConfig} */
const nextConfig = {
  // We use oxlint instead of ESLint — skip Next.js's built-in lint pass
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
