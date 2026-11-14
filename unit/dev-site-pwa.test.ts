/**
 * The dev site as its own app, 开发站 (lib/dev-site/*, docs/dev-whole-page.md):
 * its manifest beside production's, the 开发 badge on its icons (SVG and PNG),
 * the pass-through service worker, the dev-only rewrites, the page's
 * registration decision, and the gate serving these without a session.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import {
  BADGE_ANY,
  BADGE_INK,
  BADGE_MASKABLE,
  BADGE_PAPER,
  badgePng,
  badgeRgba,
  badgeStrokes,
  badgeSvg,
  oklchToRgb,
} from "@/lib/dev-site/badge";
import { crc32, decodePng, encodePng } from "@/lib/dev-site/png";
import {
  DEV_APP_ID,
  DEV_PWA_PREFIX,
  DEV_SW,
  devManifest,
  devPwaAsset,
  devPwaAssets,
  devPwaFile,
} from "@/lib/dev-site/pwa";
import { SW_SCOPE, SW_URL, serviceWorkerToRegister } from "@/lib/sw-register";
import { devSiteRewrites } from "@/lib/build/dev-site-rewrites.mjs";
import { SW_KILL_SWITCH, createGate } from "../scripts/dev/preview-gate";

const PUB = join(import.meta.dir, "../public");
const read = (name: string) => new Uint8Array(readFileSync(join(PUB, name)));
const prod = JSON.parse(readFileSync(join(PUB, "manifest.json"), "utf8"));

describe("the dev manifest", () => {
  const dev = devManifest(prod);

  test("its own name, id and icons; same origin start, scope and colours", () => {
    expect(dev.name).toBe("Lianki 开发站");
    expect(dev.short_name).toBe("开发站");
    expect(dev.id).toBe(DEV_APP_ID);
    expect(dev.id).not.toBe(prod.id);
    expect(dev.scope).toBe("/");
    expect(dev.start_url).toBe(prod.start_url);
    expect(String(dev.start_url).startsWith("/")).toBe(true);
    expect(dev.theme_color).toBe(prod.theme_color);
    expect(dev.background_color).toBe(prod.background_color);
    expect(dev.display).toBe("standalone");
    const icons = dev.icons as { src: string; sizes: string; purpose?: string }[];
    expect(icons.every((i) => i.src.startsWith(DEV_PWA_PREFIX))).toBe(true);
    expect(icons.map((i) => i.sizes)).toEqual(["any", "192x192", "512x512", "192x192", "512x512"]);
    expect(icons.filter((i) => i.purpose === "maskable")).toHaveLength(2);
    // Every icon it names is one this server makes.
    for (const i of icons) expect(devPwaFile(new URL(i.src, "https://x").pathname)).not.toBeNull();
  });

  test("production's manifest is untouched; a missing start_url falls back to /home", () => {
    expect(prod.name).toBe("Lianki");
    expect(prod.id).toBe("/");
    expect(devManifest({}).start_url).toBe("/home");
  });

  test("names no host, so preview.lianki.com and dev.lianki.com serve the same file", () => {
    const text = JSON.stringify(dev);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain("lianki.com");
  });
});

describe("the 开发 badge", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><g/></svg>\n';

  test("SVG: a plate and the strokes, before </svg>, in viewBox units", () => {
    const out = badgeSvg(svg);
    expect(
      out.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><g/>'),
    ).toBe(true);
    expect(out.trimEnd().endsWith("</svg>")).toBe(true);
    expect(out).toContain(`<rect x="140" y="660" width="720" height="280"`);
    expect(out).toContain(`fill="${BADGE_INK}"`);
    expect(out).toContain(`stroke="${BADGE_PAPER}"`);
    expect(out.match(/M/g)?.length).toBe(10); // 4 strokes of 开 + 6 of 发
  });

  test("SVG: viewBox offsets, width/height fallback, and nothing to place it in", () => {
    expect(badgeSvg('<svg viewBox="-10 -10 100 50"></svg>', BADGE_MASKABLE)).toContain(
      '<rect x="18" y="21" width="44" height="10"',
    );
    expect(badgeSvg('<svg width="200" height="100"></svg>')).toContain(
      '<rect x="28" y="66" width="144" height="28"',
    );
    expect(badgeSvg("<svg></svg>")).toBe("<svg></svg>");
    expect(badgeSvg('<svg viewBox="0 0 10 10">')).toBe('<svg viewBox="0 0 10 10">');
  });

  test("the strokes sit inside the plate", () => {
    const box = { x: 10, y: 20, w: 300, h: 100 };
    const { strokes, width } = badgeStrokes(box);
    expect(width).toBeGreaterThan(0);
    for (const s of strokes)
      for (const [x, y] of s) {
        expect(x).toBeGreaterThan(box.x);
        expect(x).toBeLessThan(box.x + box.w);
        expect(y).toBeGreaterThan(box.y);
        expect(y).toBeLessThan(box.y + box.h);
      }
  });

  test("oklch → sRGB: paper is light, ink is dark, black and white exact", () => {
    expect(oklchToRgb("oklch(1 0 0)")).toEqual([255, 255, 255]);
    expect(oklchToRgb("oklch(0 0 0)")).toEqual([0, 0, 0]);
    expect(Math.min(...oklchToRgb(BADGE_PAPER))).toBeGreaterThan(200);
    expect(Math.max(...oklchToRgb(BADGE_INK))).toBeLessThan(70);
    expect(() => oklchToRgb("#fff")).toThrow();
  });

  test("PNG: drawn into the plate only, opaque there, the rest unchanged", () => {
    const W = 64;
    const img = { width: W, height: W, data: new Uint8Array(W * W * 4) };
    const out = badgeRgba(img, BADGE_ANY);
    expect(img.data.every((v) => v === 0)).toBe(true); // the input is not changed
    const px = (x: number, y: number) => [
      ...out.data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4),
    ];
    expect(px(2, 2)).toEqual([0, 0, 0, 0]);
    expect(px(32, 10)).toEqual([0, 0, 0, 0]);
    // Plate edge (left middle, between glyphs and border): ink, fully opaque.
    expect(px(Math.round(0.17 * W), Math.round(0.8 * W))).toEqual([...oklchToRgb(BADGE_INK), 255]);
    // Some pixels carry the paper-coloured strokes.
    const paper = oklchToRgb(BADGE_PAPER);
    let strokes = 0;
    for (let i = 0; i < out.data.length; i += 4)
      if (out.data[i] === paper[0] && out.data[i + 1] === paper[1]) strokes++;
    expect(strokes).toBeGreaterThan(10);
  });

  test("the app's own icons come out badged and the same size", () => {
    for (const f of ["icon-192.png", "icon-maskable-512.png"]) {
      const before = decodePng(read(f));
      const after = decodePng(
        badgePng(read(f), f.includes("maskable") ? BADGE_MASKABLE : BADGE_ANY),
      );
      expect([after.width, after.height]).toEqual([before.width, before.height]);
      expect(after.data).not.toEqual(before.data);
    }
  });
});

describe("PNG read/write", () => {
  const img = (w: number, h: number) => {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 5)) & 0xff;
    return { width: w, height: h, data };
  };

  test("round trip, and the CRC is the standard one", () => {
    const a = img(7, 5);
    expect(decodePng(encodePng(a))).toEqual(a);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("reads every row filter and RGB input", async () => {
    const { deflateSync } = await import("node:zlib");
    const w = 3;
    const h = 5;
    const rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 11) & 0xff);
    // Filter type y on row y, applied by hand (the reference encoder).
    const raw: number[] = [];
    const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : rgb[y * w * 3 + x]!);
    const pae = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < h; y++) {
      raw.push(y);
      for (let x = 0; x < w * 3; x++) {
        const [a, b, c] = [at(x - 3, y), at(x, y - 1), at(x - 3, y - 1)];
        const pred = [0, a, b, (a + b) >> 1, pae(a, b, c)][y]!;
        raw.push((at(x, y) - pred) & 0xff);
      }
    }
    const png = encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4) });
    // Swap in an RGB IHDR and our IDAT.
    const ihdr = png.subarray(8, 8 + 25);
    const body = ihdr.subarray(8, 21);
    body[9] = 2;
    const fix = (chunk: Uint8Array) => {
      const v = new DataView(chunk.buffer, chunk.byteOffset);
      v.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
      return chunk;
    };
    const idatBody = deflateSync(new Uint8Array(raw));
    const idat = new Uint8Array(12 + idatBody.length);
    new DataView(idat.buffer).setUint32(0, idatBody.length);
    idat.set([73, 68, 65, 84], 4);
    idat.set(idatBody, 8);
    const file = new Uint8Array([
      ...png.subarray(0, 8),
      ...fix(new Uint8Array(ihdr)),
      ...fix(idat),
      0,
      0,
      0,
      0,
      73,
      69,
      78,
      68,
      0xae,
      0x42,
      0x60,
      0x82,
    ]);
    const out = decodePng(file);
    for (let i = 0; i < w * h; i++) {
      expect([...out.data.subarray(i * 4, i * 4 + 4)]).toEqual([
        rgb[i * 3]!,
        rgb[i * 3 + 1]!,
        rgb[i * 3 + 2]!,
        255,
      ]);
    }
    expect(inflateSync(idatBody).length).toBe(raw.length);
  });

  test("refuses what it cannot read", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("not a PNG");
    const png = encodePng(img(2, 2));
    const bad = new Uint8Array(png);
    bad[8 + 8 + 8] = 16; // bit depth
    expect(() => decodePng(bad)).toThrow("unsupported PNG");
    expect(() => decodePng(png.subarray(0, 8))).toThrow("without IHDR");
  });
});

describe("the dev PWA files", () => {
  test("paths: /manifest.json, /sw.js and the badged icons; nothing else", () => {
    expect(devPwaFile("/manifest.json")).toBe("manifest.json");
    expect(devPwaFile("/sw.js")).toBe("sw.js");
    expect(devPwaFile(`${DEV_PWA_PREFIX}icon-512.png`)).toBe("icon-512.png");
    expect(devPwaFile(`${DEV_PWA_PREFIX}icon.svg`)).toBe("icon.svg");
    expect(devPwaFile(`${DEV_PWA_PREFIX}manifest.json`)).toBe("manifest.json");
    expect(devPwaFile(`${DEV_PWA_PREFIX}../../.env`)).toBeNull();
    expect(devPwaFile(`${DEV_PWA_PREFIX}favicon.ico`)).toBeNull();
    expect(devPwaFile("/icon-192.png")).toBeNull();
    expect(devPwaFile("/home")).toBeNull();
  });

  test("each file and its type", () => {
    const m = devPwaAsset("manifest.json", read)!;
    expect(m.type).toContain("manifest+json");
    expect(JSON.parse(String(m.body)).short_name).toBe("开发站");
    expect(devPwaAsset("sw.js", read)).toEqual({
      type: "text/javascript; charset=utf-8",
      body: DEV_SW,
    });
    const svg = devPwaAsset("icon.svg", read)!;
    expect(svg.type).toContain("svg");
    expect(String(svg.body)).toContain(BADGE_INK);
    const png = devPwaAsset("icon-192.png", read)!;
    expect(png.type).toBe("image/png");
    expect(decodePng(png.body as Uint8Array).width).toBe(192);
    expect(devPwaAsset("nope.png", read)).toBeNull();
  });

  test("PNGs are drawn once; the manifest is read each time", () => {
    let reads = 0;
    const get = devPwaAssets((n) => (reads++, read(n)));
    get("icon-192.png");
    get("icon-192.png");
    expect(reads).toBe(1);
    get("manifest.json");
    get("manifest.json");
    expect(reads).toBe(3);
  });
});

describe("the dev service worker", () => {
  type Handler = (e: Record<string, unknown>) => void;
  async function load(cached: string[], net: () => Promise<Response>) {
    const handlers: Record<string, Handler> = {};
    const deleted: string[] = [];
    let claimed = false;
    const self = {
      addEventListener: (t: string, h: Handler) => void (handlers[t] = h),
      skipWaiting: () => {},
      clients: { claim: async () => void (claimed = true) },
    };
    const caches = {
      keys: async () => cached,
      delete: async (k: string) => (deleted.push(k), true),
    };
    new Function("self", "caches", "fetch", DEV_SW)(self, caches, net);
    const fire = async (type: string, extra: Record<string, unknown> = {}) => {
      const waits: Promise<unknown>[] = [];
      let answer: Promise<Response> | null = null;
      handlers[type]!({
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        respondWith: (p: Promise<Response>) => (answer = p),
        ...extra,
      });
      await Promise.all(waits);
      return answer as Promise<Response> | null;
    };
    return { fire, deleted, claimed: () => claimed };
  }

  test("caches nothing, drops old caches but the word clips, and takes the open pages", async () => {
    const sw = await load(["lianki-v2", "lianki-audio-v1"], async () => new Response("net"));
    await sw.fire("install");
    await sw.fire("activate");
    expect(sw.deleted).toEqual(["lianki-v2"]);
    expect(sw.claimed()).toBe(true);
    expect(DEV_SW).not.toContain("caches.open");
    expect(DEV_SW).not.toContain(".put(");
  });

  test("leaves chunks, HMR and APIs alone; page loads go to the network", async () => {
    const sw = await load([], async () => new Response("net"));
    const req = (url: string, mode: string, method = "GET") => ({ request: { url, mode, method } });
    expect(await sw.fire("fetch", req("/_next/static/chunks/a.js", "no-cors"))).toBeNull();
    expect(await sw.fire("fetch", req("/api/x", "cors"))).toBeNull();
    expect(await sw.fire("fetch", req("/_lk/dev-auth", "navigate", "POST"))).toBeNull();
    const page = await sw.fire("fetch", req("/home", "navigate"));
    expect(await (await page!).text()).toBe("net");
  });

  test("the Mac unreachable: a short page, not the browser's error", async () => {
    const sw = await load([], async () => {
      throw new TypeError("offline");
    });
    const r = await (await sw.fire("fetch", {
      request: { url: "/home", mode: "navigate", method: "GET" },
    }))!;
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("开发站");
  });
});

describe("registration and the dev-only rewrites", () => {
  test("registers /sw.js at / in a secure context with the API, else not", () => {
    expect(serviceWorkerToRegister({ serviceWorker: {} }, true)).toEqual({
      url: SW_URL,
      options: { scope: SW_SCOPE },
    });
    expect(SW_URL).toBe("/sw.js");
    expect(serviceWorkerToRegister({ serviceWorker: {} }, false)).toBeNull();
    expect(serviceWorkerToRegister({}, true)).toBeNull();
    expect(serviceWorkerToRegister(undefined, true)).toBeNull();
  });

  test("only `next dev` under the whole-page launcher rewrites the manifest and worker", () => {
    expect(devSiteRewrites({ NODE_ENV: "production", LIANKI_DEV_WHOLE_PAGE: "1" })).toEqual([]);
    expect(devSiteRewrites({ NODE_ENV: "development" })).toEqual([]);
    const r = devSiteRewrites({ NODE_ENV: "development", LIANKI_DEV_WHOLE_PAGE: "1" });
    expect(r.map((x: { source: string }) => x.source)).toEqual(["/manifest.json", "/sw.js"]);
    for (const x of r as { source: string; destination: string }[])
      expect(devPwaFile(x.destination)).toBe(devPwaFile(x.source));
  });
});

describe("the gate serves the app files without a session", () => {
  const HOST = "dev.lianki.com";
  const make = (withPwa: boolean) =>
    createGate({
      publicHost: HOST,
      ownerEmail: "owner@example.com",
      sessionKey: "k".repeat(64),
      verify: async () => null,
      active: async () => [],
      ...(withPwa ? { pwa: (p: string) => devPwaAssets(read)(devPwaFile(p) ?? "") } : {}),
    });
  const get = (gate: ReturnType<typeof make>, url: string, method = "GET", h = {}) =>
    gate.handle({ method, url, headers: { host: HOST, ...h } });

  test("manifest, icons and worker: 200 with no cookie, on whichever host it was given", async () => {
    const gate = make(true);
    const m = await get(gate, "/manifest.json");
    expect(m.kind === "respond" && m.status).toBe(200);
    if (m.kind === "respond") expect(JSON.parse(String(m.body)).name).toBe("Lianki 开发站");
    const icon = await get(gate, `${DEV_PWA_PREFIX}icon-512.png?v=1`);
    expect(icon.kind === "respond" && icon.headers["content-type"]).toBe("image/png");
    const sw = await get(gate, "/sw.js", "GET", { "service-worker": "script" });
    expect(sw.kind === "respond" && sw.body).toBe(DEV_SW);
    const head = await get(gate, "/manifest.json", "HEAD");
    expect(head.kind === "respond" && head.body).toBe("");
  });

  test("everything else keeps the 503; other workers still get the kill switch", async () => {
    const gate = make(true);
    expect((await get(gate, "/home")) as { status: number }).toMatchObject({ status: 503 });
    expect((await get(gate, "/manifest.json", "POST")) as { status: number }).toMatchObject({
      status: 503,
    });
    expect(await get(gate, "/x/sw.js")).toMatchObject({ body: SW_KILL_SWITCH });
    expect(await get(make(false), "/sw.js")).toMatchObject({ body: SW_KILL_SWITCH });
    expect(await get(make(false), "/manifest.json")).toMatchObject({ status: 503 });
  });

  test("still only its own host", async () => {
    const r = await make(true).handle({
      method: "GET",
      url: "/manifest.json",
      headers: { host: "preview.lianki.com" },
    });
    expect(r).toMatchObject({ status: 503 });
  });
});

describe("the route (app/api/dev-whole-page/pwa/[file])", () => {
  const call = async (file: string, env: Record<string, string | undefined>) => {
    const { GET } = await import("@/app/api/dev-whole-page/pwa/[file]/route");
    const saved = { w: process.env.LIANKI_DEV_WHOLE_PAGE, n: process.env.NODE_ENV };
    Object.assign(process.env, env);
    try {
      return await GET(new Request(`https://x/${file}`), { params: Promise.resolve({ file }) });
    } finally {
      process.env.LIANKI_DEV_WHOLE_PAGE = saved.w;
      if (saved.w === undefined) delete process.env.LIANKI_DEV_WHOLE_PAGE;
      Object.assign(process.env, { NODE_ENV: saved.n });
    }
  };

  test("404 outside the whole-page dev server (production)", async () => {
    expect(
      (await call("manifest.json", { NODE_ENV: "production", LIANKI_DEV_WHOLE_PAGE: "1" })).status,
    ).toBe(404);
  });

  test("the dev files under it; 404 for any other name", async () => {
    const dev = { NODE_ENV: "development", LIANKI_DEV_WHOLE_PAGE: "1" };
    const m = await call("manifest.json", dev);
    expect(m.status).toBe(200);
    expect((await m.json()).id).toBe(DEV_APP_ID);
    const png = await call("icon-512.png", dev);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(decodePng(new Uint8Array(await png.arrayBuffer())).width).toBe(512);
    expect((await call("secret.txt", dev)).status).toBe(404);
  });
});
