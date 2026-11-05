/**
 * A minimal custom frontend for Lianki (docs/custom-frontend.md): a
 * client-only Vite app, viewed at https://lianki.com/<any path>?live=<id>.
 *
 * Everything Vite serves lives under /_next/, the one path lianki.com passes
 * through to your tunnel (with the HMR socket); the page itself comes from
 * any other path, so it is rewritten to the app's index.html here. /api
 * stays on lianki.com: same origin, your own session.
 *
 *   bunx vite --config examples/custom-frontend-vite/vite.config.ts
 *   cloudflared tunnel --url http://localhost:5188
 */
import { defineConfig, type Plugin } from "vite";

/** Any page path → the app (Vite answers only under `base`). */
const pagesToIndex: Plugin = {
  name: "lianki-pages-to-index",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && !req.url.startsWith("/_next/")) req.url = "/_next/";
      next();
    });
  },
};

export default defineConfig({
  root: import.meta.dirname,
  base: "/_next/",
  plugins: [pagesToIndex],
  server: {
    port: 5188,
    strictPort: true,
    // lianki.com's Worker fetches with your tunnel's Host.
    allowedHosts: [".trycloudflare.com"],
    // The browser's HMR socket goes to wss://lianki.com/_next/, which lianki.com passes on.
    hmr: { protocol: "wss", clientPort: 443 },
  },
});
