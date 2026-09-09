import { fileURLToPath } from "url";
import { defineConfig, type Plugin } from "vite";
import monkey from "vite-plugin-monkey";
import { parseUserscriptMeta, withoutAutoUpdate } from "./scripts/userscript-meta";

/**
 * Live-reload dev server for the Tampermonkey userscript.
 *
 *   bun run dev:userscript          # localhost only
 *   bun run dev:userscript:tunnel   # + a public https URL (see scripts/dev-userscript.ts)
 *
 * This config is DEV-ONLY and deliberately does not touch the release path.
 * `bun run build:userscript` (userbuild) remains the only thing that writes
 * public/lianki.user.js, because three separate things read that exact file:
 * scripts/pre-commit.ts extracts its metadata block into lianki.meta.js, the
 * pre-commit version check diffs its @version against HEAD, and
 * unit/normalizeUrl-userscript-drift.test.ts brace-matches normalizeUrl out of
 * it. A vite build landing there would break all three, so output goes to the
 * gitignored tmp/ instead.
 */

const ENTRY = "src/lianki.user.ts";
const DEV_OUT = "tmp/userscript-dev";

/**
 * Note the `.dev.` — it must NOT be `lianki.user.js`. Vite's default publicDir is
 * `public/`, which is exactly where the *released* bundle lives, so a dev script
 * named `lianki.user.js` gets shadowed by the static release file at the same
 * route and Tampermonkey silently installs production instead. publicDir is
 * disabled below as the real fix; the distinct name keeps the URL unambiguous.
 */
export const DEV_FILE_NAME = "lianki.dev.user.js";

// Set by scripts/dev-userscript.ts once the quick tunnel reports its hostname.
// Vite bakes the HMR client's connection details in at serve time, so the public
// origin has to be known before the server boots — hence the env handoff rather
// than discovering it later.
const publicOrigin = process.env.LIANKI_DEV_ORIGIN;
const publicHost = publicOrigin ? new URL(publicOrigin).host : undefined;

const corePath = (f: string) => fileURLToPath(new URL(`./packages/core/src/${f}`, import.meta.url));

/**
 * vite-plugin-monkey computes its entry URL from the install request's `?origin`
 * query param, else falls back to server.host — which is 0.0.0.0 here, so it
 * would mint http://127.0.0.1:5173/… that never reaches this box through the
 * tunnel. It never reads vite's server.origin, so derive the real origin from
 * the *incoming request* instead: cloudflared forwards the public Host and sets
 * X-Forwarded-Proto: https, so the shim gets https://dev.lianki.com with no
 * `?origin` on the URL. Local (no-tunnel) requests fall back to their own Host.
 */
const autoOrigin = (fallback?: string): Plugin => ({
  name: "lianki:auto-origin",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Through the tunnel, Cloudflare caches .js by default (max-age=14400) —
      // a stale install shim/entry would hand back yesterday's code. no-store on
      // every response, matching the loader server.
      res.setHeader("cache-control", "no-store, max-age=0");
      const u = new URL(req.url ?? "/", "http://localhost");
      if (u.pathname !== "/__vite-plugin-monkey.install.user.js" || u.searchParams.has("origin"))
        return next();
      const first = (h: string | string[] | undefined) =>
        (Array.isArray(h) ? h[0] : h)?.split(",")[0].trim();
      const proto =
        first(req.headers["x-forwarded-proto"]) ?? (server.config.server.https ? "https" : "http");
      const host = first(req.headers["x-forwarded-host"]) ?? req.headers.host;
      const origin = fallback ?? (host ? `${proto}://${host}` : undefined);
      if (origin) {
        u.searchParams.set("origin", origin);
        req.url = `${u.pathname}${u.search}`;
      }
      next();
    });
  },
});

export default defineConfig({
  // Rollup does not read tsconfig `paths` the way bun's bundler does, so the
  // workspace aliases have to be restated. Both forms are needed: the barrel,
  // and the deep import the userscript uses for @lianki/core/watchStats.
  resolve: {
    alias: [
      { find: /^@lianki\/core$/, replacement: corePath("index.ts") },
      { find: /^@lianki\/core\/(.*)$/, replacement: `${corePath("")}$1.ts` },
    ],
  },
  plugins: [
    autoOrigin(publicOrigin),
    monkey({
      entry: ENTRY,
      userscript: withoutAutoUpdate(parseUserscriptMeta(ENTRY)),
      server: {
        // The source uses bare GM_* globals (declare const ...), not ESM imports
        // from '$', so they have to exist on the page's window in dev.
        mountGmApi: true,
        // No DISPLAY on a headless dev box; the install URL is printed instead.
        open: false,
        prefix: (name) => `[dev] ${name}`,
      },
      build: { fileName: DEV_FILE_NAME, metaFileName: true },
    }),
  ],
  // Nothing here needs static assets, and leaving it on would re-expose the
  // release bundle in public/ at the same origin as the dev script.
  publicDir: false,
  build: { outDir: DEV_OUT, emptyOutDir: true },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    ...(publicHost && {
      origin: publicOrigin,
      allowedHosts: [publicHost],
      // Quick tunnels terminate TLS at Cloudflare and speak 443 to the client,
      // so the HMR websocket has to be told wss/443 rather than the local port.
      hmr: { protocol: "wss", host: publicHost, clientPort: 443 },
    }),
  },
});
