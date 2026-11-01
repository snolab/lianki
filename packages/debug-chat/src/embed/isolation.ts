/**
 * Style and key isolation for the Learning Partner on other sites
 * (docs/dev-debug-widget.md, "On every site"). The widget lives in a closed
 * shadow root on a host element of its own:
 *
 * - **In:** the host carries `all: initial` inline with `!important` (an
 *   inline important declaration beats any stylesheet, even `* { all: unset
 *   !important }`), and `:host { all: initial }` resets what inherits into the
 *   tree (font, colour, line height, direction, letter spacing). Page
 *   selectors never match inside a shadow root.
 * - **Font:** `system-ui` first. It is a generic family, so no page
 *   `@font-face` can redefine it; the named families after it only matter on
 *   a browser without system-ui. Every size is px: `rem` follows the page's
 *   `html { font-size }`, so the widget's CSS has every rem rewritten to px.
 * - **Out:** every rule goes into the shadow root (adoptedStyleSheets, else a
 *   `<style>` inside it), `:root` becomes `:host`, and nothing is added to the
 *   document but the one host element. No `@font-face`, no `@property`.
 * - **CSP:** constructed stylesheets are not governed by `style-src`, and the
 *   host's inline style is set through the CSSOM, which CSP allows too. Only
 *   the `<style>` fallback can be blocked; `attachStyles` reports that.
 */

/**
 * The host element's tag: a built-in `div`, never a custom element name. A
 * page could define a custom tag first (customElements.define) with a class
 * that calls attachInternals(); its ElementInternals.shadowRoot would then
 * hand the page our closed root. A plain div created by us (no `is=`) can
 * never be upgraded by page code.
 */
export const HOST_TAG = "div";

/**
 * The widget's own font stack. `system-ui` (generic, unspoofable) first; the
 * named ones are the platforms' UI fonts, CJK included, for browsers without it.
 */
export const FONT_STACK =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "PingFang SC", "Hiragino Sans", "Microsoft YaHei", sans-serif';

/** The root font size, px. Everything the widget's CSS said in rem is this many px per rem. */
export const ROOT_PX = 16;

/** `1.5rem` → `24px`, everywhere in a stylesheet (calc() included). */
export function remToPx(css: string, base = ROOT_PX): string {
  return css.replace(/(-?(?:\d+\.?\d*|\.\d+))rem\b/g, (_m, n: string) => {
    const px = Number(n) * base;
    return `${Number.isInteger(px) ? px : Number(px.toFixed(4))}px`;
  });
}

/**
 * Selectors that mean the document, rewritten to the shadow host: `:root`
 * (Tailwind's theme, the app's colours) and a bare `html`/`body` rule.
 */
export function rootToHost(css: string): string {
  return css
    .replace(/:root\b/g, ":host")
    .replace(/(^|[},]\s*)(html|body)(\s*[{,])/g, "$1:host$3")
    .replace(/:host\s*,\s*:host\b/g, ":host");
}

/** Drop what would leak out of a shadow root or is ignored in one: @font-face, @property, @import. */
export function dropGlobalRules(css: string): string {
  let out = css.replace(/@import[^;]*;/g, "");
  for (const at of ["@font-face", "@property"]) {
    let i = out.indexOf(at);
    while (i !== -1) {
      const open = out.indexOf("{", i);
      let depth = 0;
      let end = open;
      for (; end < out.length; end++) {
        if (out[end] === "{") depth++;
        else if (out[end] === "}" && --depth === 0) break;
      }
      out = out.slice(0, i) + out.slice(end + 1);
      i = out.indexOf(at, i);
    }
  }
  return out;
}

/** The widget's CSS, made safe for the shadow root: px only, :host, nothing global. */
export function isolateCss(css: string): string {
  return remToPx(rootToHost(dropGlobalRules(css)));
}

/**
 * The shadow root's own reset, first in the cascade: the host shows nothing
 * of the page's styles, and the widget's root starts from the font stack, in px.
 */
export function baseCss(): string {
  // The resets go in the `base` layer, under Tailwind's `utilities`: an
  // unlayered reset would beat every utility (text-base, px-2…).
  return [
    `@layer theme, base, components, utilities;`,
    `:host{all:initial!important;display:block!important;position:fixed!important;inset:auto 0 0 auto!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;contain:none!important}`,
    `@layer base{`,
    `.lk-partner-root{all:initial;display:block;font-family:${FONT_STACK};font-size:14px;line-height:1.4;font-weight:400;font-style:normal;letter-spacing:normal;word-spacing:normal;text-transform:none;text-align:start;text-indent:0;text-shadow:none;white-space:normal;direction:ltr;color:var(--foreground,oklch(0.25 0.02 65));-webkit-text-size-adjust:100%;text-size-adjust:100%;-webkit-font-smoothing:antialiased;cursor:auto;visibility:visible;pointer-events:none}`,
    `.lk-partner-root *,.lk-partner-root *::before,.lk-partner-root *::after{box-sizing:border-box;border:0 solid;margin:0;padding:0;font-family:inherit}`,
    `.lk-partner-root button,.lk-partner-root input,.lk-partner-root textarea,.lk-partner-root select{font:inherit;color:inherit;background:transparent;letter-spacing:inherit}`,
    `.lk-partner-root ol,.lk-partner-root ul{list-style:none}.lk-partner-root [hidden]{display:none!important}`,
    `.lk-partner-root img,.lk-partner-root svg{display:block;max-width:none}`,
    `}`,
  ].join("\n");
}

/**
 * The host's inline style, each `!important`: an inline important
 * declaration beats every stylesheet, the page's `* { all: unset !important }`
 * included. Set through the CSSOM, which CSP's style-src does not govern.
 */
export const HOST_STYLE: [string, string][] = [
  ["all", "initial"],
  ["display", "block"],
  ["position", "fixed"],
  ["inset", "auto 0px 0px auto"],
  ["width", "0px"],
  ["height", "0px"],
  ["overflow", "visible"],
  ["z-index", "2147483647"],
  ["margin", "0px"],
  ["padding", "0px"],
  ["border", "0px"],
  ["transform", "none"],
  ["filter", "none"],
  ["contain", "none"],
  ["visibility", "visible"],
  ["opacity", "1"],
  ["pointer-events", "none"],
];

export function applyHostStyle(el: HTMLElement) {
  for (const [k, v] of HOST_STYLE) el.style.setProperty(k, v, "important");
}

export type StyleMode = "adopted" | "style" | "blocked";

/**
 * Put `css` into the shadow root, never the document. adoptedStyleSheets
 * first (CSP cannot block it); else a `<style>` inside the root, which a
 * strict style-src can. Reports which.
 */
export function attachStyles(root: ShadowRoot, css: string[]): StyleMode {
  const doc = root.ownerDocument;
  const Sheet = doc.defaultView?.CSSStyleSheet ?? globalThis.CSSStyleSheet;
  try {
    if (Sheet && "adoptedStyleSheets" in root && "replaceSync" in Sheet.prototype) {
      root.adoptedStyleSheets = css.map((c) => {
        const s = new Sheet();
        s.replaceSync(c);
        return s;
      });
      return "adopted";
    }
  } catch {}
  for (const c of css) {
    const el = doc.createElement("style");
    el.textContent = c;
    root.append(el);
  }
  // A blocked <style> stays in the DOM with no sheet.
  const styles = [...root.querySelectorAll("style")];
  return styles.length && styles.every((s) => s.sheet) ? "style" : "blocked";
}

/** The keyboard events the shadow root keeps to itself. */
export const GUARDED_KEYS = ["keydown", "keyup", "keypress"] as const;

/**
 * Keys typed in the widget stay in the widget: stopped at the shadow root,
 * in the bubble phase, after the widget's own handlers (React listens on its
 * container, inside the root) and before the host page's (document, window).
 *
 * Only events from inside the root ever reach a listener on it: a key
 * pressed while the page has focus is dispatched to the page's element and
 * never passes through here. So this can never swallow the page's own keys.
 * Nothing is added to document or window.
 *
 * Limit: a page listener in the capture phase on window or document still
 * sees the key first (capture runs before the target); it sees the host
 * element as the target, as if a custom element had focus.
 */
export function guardKeys(root: ShadowRoot): () => void {
  const stop = (e: Event) => e.stopPropagation();
  for (const t of GUARDED_KEYS) root.addEventListener(t, stop);
  return () => {
    for (const t of GUARDED_KEYS) root.removeEventListener(t, stop);
  };
}

export type ShadowHost = {
  host: HTMLElement;
  /** The closed root: held here only, never reachable from the page (host.shadowRoot is null). */
  root: ShadowRoot;
  /** The element the widget renders into. */
  container: HTMLElement;
  styles: StyleMode;
  destroy(): void;
};

/**
 * The host element, its closed shadow root, the styles and the key guard.
 * Appended to <html>, not <body>, so a transform or filter the page puts on
 * body cannot become the fixed widget's containing block.
 */
export function createShadowHost(doc: Document, css: string[]): ShadowHost {
  const host = doc.createElement(HOST_TAG);
  applyHostStyle(host);
  const root = host.attachShadow({ mode: "closed" });
  const styles = attachStyles(root, [baseCss(), ...css.map(isolateCss)]);
  const container = doc.createElement("div");
  container.className = "lk-partner-root";
  root.append(container);
  const unguard = guardKeys(root);
  (doc.documentElement ?? doc.body).append(host);
  return {
    host,
    root,
    container,
    styles,
    destroy() {
      unguard();
      host.remove();
    },
  };
}
