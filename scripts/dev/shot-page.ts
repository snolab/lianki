/**
 * What `bun scripts/dev/shot.ts` runs on the page, as eval code: shot.ts
 * sends this function's source and calls it with DebugEval's `$lk`, the
 * options, and shot-lib's `burst`. So it must stay self-contained: no
 * imports, no outer names (types are erased).
 *
 * It renders the page with modern-screenshot (DOM → SVG foreignObject →
 * canvas), imported once from jsDelivr and kept on `window`, and streams
 * each PNG back with `$lk.send` as JSON {i, at, ms, w, h, png} (png is
 * base64). The result is a small summary.
 */
import type { BurstShot, burst as Burst } from "./shot-lib";

export type PageShotOpts = {
  lib: string;
  maxDpr: number;
  burst: number;
  every: number;
  selector?: string;
  /** Per remote asset (image, font), ms. */
  timeout: number;
};

type Lib = {
  domToCanvas: (node: Element, options: Record<string, unknown>) => Promise<HTMLCanvasElement>;
};

export async function pageShot(
  $lk: { send(data: string): number } | undefined,
  opts: PageShotOpts,
  burst: typeof Burst,
): Promise<Record<string, unknown>> {
  if (!$lk?.send)
    throw new Error("this page cannot stream results ($lk): it needs a deploy, then a reload");
  const w = window as unknown as { __lkShotLib?: Promise<Lib> } & Window;
  const t0 = performance.now();
  // Imported once per page: repeat shots skip it. A failed import is not kept.
  const lib = await (w.__lkShotLib ??= import(opts.lib).catch((e: unknown) => {
    w.__lkShotLib = undefined;
    throw e;
  }));
  const importMs = Math.round(performance.now() - t0);
  const el = opts.selector ? document.querySelector(opts.selector) : document.documentElement;
  if (!el) throw new Error(`nothing matches ${opts.selector}`);
  const scale = Math.min(w.devicePixelRatio || 1, opts.maxDpr);

  const take = async (i: number) => {
    const s0 = performance.now();
    const at = Math.round(s0 - t0);
    const full = !opts.selector;
    const root = document.documentElement;
    // The document's own scroll: shift the clone's root by it. Its fixed
    // elements stay put (fixed in the foreignObject is relative to the
    // viewport-sized box), and position: relative carries absolute ones along.
    const sx = full ? w.scrollX : 0;
    const sy = full ? w.scrollY : 0;
    const bodyTransform = document.body.style.transform;
    // The page's background, as the browser paints it past the root's box.
    const bg = [root, document.body]
      .map((e) => getComputedStyle(e).backgroundColor)
      .find((c) => c && c !== "transparent" && !/(,|\/)\s*0\)$/.test(c));
    const canvas = await lib.domToCanvas(el, {
      scale,
      // The full layout viewport, so the safe-area insets are in it too.
      ...(full ? { width: w.innerWidth, height: w.innerHeight } : {}),
      timeout: opts.timeout,
      // Inner scrollers (a list scrolled inside the page) keep their offset.
      features: { restoreScrollPosition: true },
      // An image that fails (cross-origin, gone) is left blank, not fatal.
      fetch: {
        placeholderImage:
          "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      },
      // Safari's redraws for images in the SVG: shorter waits than the default 100 ms.
      drawImageInterval: 20,
      onCloneNode: (c: Node) => {
        if (!full || !(c instanceof HTMLElement)) return;
        // restoreScrollPosition moved <body> by the document's scroll with a
        // transform, which would pin fixed elements to the body: undo that.
        const body = [...c.children].find((x) => x.tagName === "BODY") as HTMLElement | undefined;
        if (body) body.style.transform = bodyTransform;
        if (getComputedStyle(root).position === "static") c.style.position = "relative";
        c.style.marginTop = `${-sy}px`;
        c.style.marginLeft = `${-sx}px`;
      },
    });
    // Crop to the visual viewport (pinch zoom, an on-screen keyboard), on
    // the page's background.
    let [x, y, cw, ch] = [0, 0, canvas.width, canvas.height];
    const vv = w.visualViewport;
    if (full && vv) {
      x = Math.round(vv.offsetLeft * scale);
      y = Math.round(vv.offsetTop * scale);
      cw = Math.min(canvas.width - x, Math.round(vv.width * scale));
      ch = Math.min(canvas.height - y, Math.round(vv.height * scale));
    }
    const out = document.createElement("canvas");
    out.width = cw;
    out.height = ch;
    const g = out.getContext("2d");
    if (g) {
      g.fillStyle = bg ?? "white";
      g.fillRect(0, 0, cw, ch);
      g.drawImage(canvas, x, y, cw, ch, 0, 0, cw, ch);
    }
    const url = out.toDataURL("image/png");
    $lk.send(
      JSON.stringify({
        i,
        at,
        ms: Math.round(performance.now() - s0),
        w: out.width,
        h: out.height,
        png: url.slice(url.indexOf(",") + 1),
      }),
    );
  };

  const shots: BurstShot[] = await burst(opts.burst, opts.every, take, {
    now: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  return {
    shots: shots.length,
    errors: shots.filter((s) => s.error).map((s) => `#${s.i + 1}: ${s.error}`),
    importMs,
    scale,
    viewport: [w.innerWidth, w.innerHeight],
  };
}
