// Geometry regression for the real NavLink source and compiled app CSS.
// Covers the selected stamp at its largest animation frame, in LTR/RTL.
// This isolates rail/drawer link slots; full shell layout stays in qa-ui.
import { chromium } from "playwright";
import { launchSilent, newSilentContext } from "./silent.mjs";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { TEXT_MAX } from "../../lib/text-size-boot.ts";
const source = await readFile("app/components/AppShell.tsx", "utf8");
const link = source.slice(
  source.indexOf("function NavLink("),
  source.indexOf('/**\n * "⋯"', source.indexOf("function NavLink(")),
);
const built = await Bun.build({
  entrypoints: ["rail-entry"],
  target: "browser",
  plugins: [
    {
      name: "rail-fixture",
      setup(build) {
        build.onResolve({ filter: /^rail-entry$/ }, () => ({ path: "entry", namespace: "rail" }));
        build.onLoad({ filter: /.*/, namespace: "rail" }, () => ({
          loader: "tsx",
          resolveDir: process.cwd(),
          contents: `
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {Icon,SealIcon} from ${JSON.stringify(resolve("app/components/icons.tsx"))};
 const Link=(props:any)=><a {...props}/>;
 ${link}
 createRoot(document.getElementById('root')).render(<nav className="lk-rail-scroll flex flex-col gap-2 px-3 py-3" style={{width:224,height:180}}><NavLink item={{href:'/home',icon:'house'}} label="A deliberately long navigation label" active/><NavLink item={{href:'/words',icon:'bookOpen'}} label="Word lists" active={false}/></nav>);
 `,
        }));
      },
    },
  ],
});
if (!built.success) throw new Error(built.logs.join("\n"));
const css = (
  await postcss([tailwind()]).process(await readFile("app/globals.css", "utf8"), {
    from: resolve("app/globals.css"),
  })
).css;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    return p === "/entry.js"
      ? new Response(built.outputs[0])
      : p === "/style.css"
        ? new Response(css, { headers: { "content-type": "text/css" } })
        : new Response(
            '<link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/entry.js"></script>',
            { headers: { "content-type": "text/html" } },
          );
  },
});
const browser = await launchSilent(chromium);
const ctx = await newSilentContext(browser);
const page = await ctx.newPage();
try {
  await page.goto(server.url.toString());
  await page.locator("nav svg").first().waitFor();
  const results = [];
  for (const scale of [1, TEXT_MAX])
    for (const dir of ["ltr", "rtl"]) {
      await page.evaluate(
        ({ scale, dir }) => {
          document.documentElement.style.setProperty("--lk-fs-ui", String(scale));
          document.documentElement.dir = dir;
        },
        { scale, dir },
      );
      await page.waitForTimeout(300);
      for (const phase of ["settled", "stamp"]) {
        const result = await page.evaluate((phase) => {
          const svg = document.querySelector(".lk-seal");
          if (phase === "stamp") svg.style.transform = "rotate(-4deg) scale(1.6)";
          else svg.style.transform = "rotate(-4deg)";
          const b = svg.getBoundingClientRect(),
            n = document.querySelector("nav").getBoundingClientRect();
          return {
            left: b.left - n.left,
            right: n.right - b.right,
            top: b.top - n.top,
            bottom: n.bottom - b.bottom,
            clipped:
              b.left < n.left - 0.5 ||
              b.right > n.right + 0.5 ||
              b.top < n.top - 0.5 ||
              b.bottom > n.bottom + 0.5,
          };
        }, phase);
        results.push({ scale, dir, phase, ...result });
      }
    }
  assert.deepEqual(
    results.filter((r) => r.clipped),
    [],
    "No selected stamp may cross the scrolling rail boundary",
  );
  console.log(
    `PASS: ${results.length} rail icon geometry cases (normal/max UI text, LTR/RTL, settled/stamping), using real NavLink and app CSS.`,
  );
} finally {
  await ctx.close();
  await browser.close();
  server.stop(true);
}
