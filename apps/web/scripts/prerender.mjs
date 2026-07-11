// Prerender the landing route ("/") into <dist>/index.html so crawlers and first
// paint get real content — the rest of the app is authed and stays a client SPA.
//
// Reusable across builds: serves the given dist dir with a tiny static server
// (SPA fallback), renders "/" in headless Chromium (Playwright), captures the
// #root HTML, and injects it into index.html. Using the real renderer means
// intlayer/router/styles all resolve without a separate SSR entry.
//
//   node scripts/prerender.mjs [distDir]      (default: dist)
//   node ../web/scripts/prerender.mjs dist/client   (apps/api's client build)

import { createServer } from "node:http";
import { readFile, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { chromium } from "playwright";

const distDir = resolve(process.argv[2] || "dist");
const indexPath = join(distDir, "index.html");
if (!existsSync(indexPath)) {
  console.error(`prerender: ${indexPath} not found — run the build first.`);
  process.exit(1);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Static server with SPA fallback to index.html.
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const filePath = join(distDir, urlPath === "/" ? "index.html" : urlPath);
  // ACAO:* so <script crossorigin> (emitted by @cloudflare/vite-plugin) executes.
  const cors = { "access-control-allow-origin": "*" };
  readFile(filePath, (err, data) => {
    if (err) {
      readFile(indexPath, (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { "content-type": "text/html", ...cors });
        res.end(e2 ? "not found" : html);
      });
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(filePath)] || "application/octet-stream",
      ...cors,
    });
    res.end(data);
  });
});

let exitCode = 0;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Surface client-side failures — otherwise a suspended/erroring render just
  // looks like a selector timeout.
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push("console.error: " + m.text());
  });
  page.on("requestfailed", (r) =>
    pageErrors.push(`requestfailed ${r.url()} — ${r.failure()?.errorText}`),
  );
  const template = readFileSync(indexPath, "utf8");

  // Render one route and return its #root HTML. "load" not "networkidle":
  // useSession's fetch to the SPA-fallback keeps the network busy.
  async function renderRoute(route) {
    await page.goto(origin + route, { waitUntil: "load" });
    try {
      await page.waitForSelector("#root h1", { timeout: 15_000 });
    } catch (e) {
      const rootNow = await page.$eval("#root", (el) => el.innerHTML).catch(() => "(no #root)");
      console.error(`prerender: ${route} <h1> never rendered. Client errors:`);
      for (const err of pageErrors.slice(0, 8)) console.error("  •", err.slice(0, 240));
      console.error("prerender: #root at timeout (first 600 chars):\n", rootNow.slice(0, 600));
      throw e;
    }
    return page.$eval("#root", (el) => el.innerHTML);
  }

  function writeRoute(route, rootHtml) {
    const html = template.replace(
      /(<div id="root">)[\s\S]*?(<\/div>)/,
      (_m, open, closeTag) => open + rootHtml + closeTag,
    );
    // "/" → index.html; "/blog/x" → blog/x/index.html (Workers Static Assets).
    const out = route === "/" ? indexPath : join(distDir, route.replace(/^\//, ""), "index.html");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    console.log(`prerender: ${route} → ${out} (${rootHtml.length} chars)`);
  }

  // Landing first (also proves the home i18n path).
  writeRoute("/", await renderRoute("/"));
  // Blog index + every post link it exposes (crawlable static HTML per post).
  const blogRoot = await renderRoute("/blog");
  writeRoute("/blog", blogRoot);
  const postRoutes = [
    ...new Set(
      (
        await page.$$eval('#root a[href^="/blog/"]', (as) => as.map((a) => a.getAttribute("href")))
      ).filter(Boolean),
    ),
  ];
  for (const route of postRoutes) writeRoute(route, await renderRoute(route));
  console.log(`prerender: ${postRoutes.length} blog posts prerendered`);
  await browser.close();
} catch (e) {
  console.error("prerender failed:", e);
  exitCode = 1;
} finally {
  server.close();
}
process.exit(exitCode);
