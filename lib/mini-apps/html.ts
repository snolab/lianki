/**
 * The file as the iframe gets it: the theme, the CSP <meta> (srcdoc mode),
 * the style pack and the SDK's <script> go first, before anything of the
 * app's, so no app markup runs ahead of them. Pure.
 */
export type Theme = "light" | "dark";

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** The pack's own <link>, which the inlined copy replaces. */
const PACK_LINK = /<link\b[^>]*\bhref\s*=\s*["']?\/m\/presets\/lianki\.css["']?[^>]*>/gi;
/** Root-relative /m/presets/ references, made absolute on Lianki's origin. */
const PRESET_REF = /\b(src|href)\s*=\s*(["']?)\/m\/presets\//gi;

export function prepareHtml(
  html: string,
  o: {
    sdkSrc: string;
    cspMeta?: string;
    /** The style pack's CSS, inlined (srcdoc mode). */
    inlineCss?: string;
    /** Lianki's origin: /m/presets/ references point there. */
    assets?: string;
    /** `auto` until the host page knows its theme (withTheme). */
    theme?: Theme | "auto";
  },
): string {
  let body = html;
  if (o.inlineCss) body = body.replace(PACK_LINK, "");
  if (o.assets) {
    const base = o.assets.replace(/\/+$/, "");
    body = body.replace(
      PRESET_REF,
      (_m, attr: string, q: string) => `${attr}=${q}${base}/m/presets/`,
    );
  }
  const head =
    (o.theme ? `<html data-theme="${o.theme}">` : "") +
    (o.cspMeta ? `<meta http-equiv="Content-Security-Policy" content="${esc(o.cspMeta)}">` : "") +
    (o.theme ? `<meta name="color-scheme" content="light dark">` : "") +
    (o.inlineCss
      ? `<style data-lk-pack>${o.inlineCss.replace(/<\/style/gi, "<\\/style")}</style>`
      : "") +
    `<script src="${esc(o.sdkSrc)}"></script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(body);
  if (doctype) return doctype[0] + head + body.slice(doctype[0].length);
  return head + body;
}

/** The srcdoc with the host page's theme in place of `auto` (set once, before it loads). */
export function withTheme(srcdoc: string, theme: Theme): string {
  return srcdoc.replace('<html data-theme="auto">', `<html data-theme="${theme}">`);
}

/** The theme the host page shows now (the site follows the system's). */
export function hostTheme(mq: { matches: boolean } | null | undefined): Theme {
  return mq?.matches ? "dark" : "light";
}
