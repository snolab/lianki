/**
 * Li chat from the userscript pill: the trust prompt and the sites list
 * (docs/userscript-li-chat.md). Trusted userscript code, plain DOM:
 *
 * - each dialog is a plain <div> host (never a custom tag the page could have
 *   defined) holding a **closed** shadow root, styled through the CSSOM with
 *   `!important` (no stylesheet, so no CSP question and nothing for the page's
 *   rules to reach);
 * - every button acts only on a **trusted** event (`isTrusted`): a click the
 *   page synthesizes (`el.click()`, dispatchEvent) never allows a site, and
 *   the page cannot reach the buttons anyway (closed root);
 * - nothing secret is in them: a hostname, the copy, the buttons.
 */
import type { PillChatStrings } from "./pill-chat-strings";
import type { SiteDecision, TrustChoice, TrustStore } from "./pill-chat-trust";

type Rules = [string, string][];
const css = (el: HTMLElement, rules: Rules) => {
  for (const [k, v] of rules) el.style.setProperty(k, v, "important");
};

/** Light and dark palettes, oklch only; text pairs pass WCAG AA on their surface. */
function palette(win: Pick<Window, "matchMedia"> | undefined) {
  let dark = false;
  try {
    dark = !!win?.matchMedia?.("(prefers-color-scheme: dark)").matches;
  } catch {}
  return dark
    ? {
        surface: "oklch(0.24 0.01 65)",
        text: "oklch(0.95 0.01 82)",
        muted: "oklch(0.8 0.01 82)",
        line: "oklch(0.95 0.01 82 / 0.18)",
        warnBg: "oklch(0.32 0.06 70)",
        warnText: "oklch(0.95 0.04 85)",
        primary: "oklch(0.78 0.11 250)",
        primaryText: "oklch(0.2 0.03 250)",
        button: "oklch(0.32 0.01 65)",
        scrim: "oklch(0 0 0 / 0.45)",
      }
    : {
        surface: "oklch(0.985 0.006 82)",
        text: "oklch(0.25 0.02 65)",
        muted: "oklch(0.42 0.02 65)",
        line: "oklch(0.25 0.02 65 / 0.15)",
        warnBg: "oklch(0.95 0.05 85)",
        warnText: "oklch(0.32 0.06 60)",
        primary: "oklch(0.45 0.13 250)",
        primaryText: "oklch(0.99 0 0)",
        button: "oklch(0.93 0.01 82)",
        scrim: "oklch(0 0 0 / 0.3)",
      };
}
type Palette = ReturnType<typeof palette>;

type Shell = { host: HTMLElement; panel: HTMLElement; remove(): void };

/** A full-screen scrim and a centred panel, in a closed shadow root on a plain div. */
function modal(doc: Document, p: Palette, label: string, onDismiss: () => void): Shell {
  const host = doc.createElement("div");
  css(host, [
    ["all", "initial"],
    ["display", "block"],
    ["position", "fixed"],
    ["inset", "0"],
    ["z-index", "2147483647"],
  ]);
  const root = host.attachShadow({ mode: "closed" });
  const scrim = doc.createElement("div");
  css(scrim, [
    ["all", "initial"],
    ["display", "flex"],
    ["position", "fixed"],
    ["inset", "0"],
    ["align-items", "center"],
    ["justify-content", "center"],
    ["padding", "16px"],
    ["background", p.scrim],
    ["box-sizing", "border-box"],
  ]);
  const panel = doc.createElement("div");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", label);
  css(panel, [
    ["all", "initial"],
    ["display", "flex"],
    ["flex-direction", "column"],
    ["gap", "12px"],
    ["box-sizing", "border-box"],
    ["width", "min(380px, 100%)"],
    ["max-height", "calc(100vh - 32px)"],
    ["overflow", "auto"],
    ["padding", "16px"],
    ["border-radius", "14px"],
    ["background", p.surface],
    ["color", p.text],
    ["border", `1px solid ${p.line}`],
    ["box-shadow", "0 8px 32px oklch(0 0 0 / 0.3)"],
    ["font", "14px/20px system-ui, sans-serif"],
  ]);
  scrim.append(panel);
  root.append(scrim);
  // A trusted click on the scrim itself (not the panel) dismisses.
  scrim.addEventListener("click", (e) => {
    if (e.isTrusted && e.target === scrim) onDismiss();
  });
  host.addEventListener("keydown", (e) => {
    if (e.isTrusted && e.key === "Escape") onDismiss();
  });
  (doc.documentElement ?? doc.body).append(host);
  return { host, panel, remove: () => host.remove() };
}

function button(
  doc: Document,
  text: string,
  kind: "primary" | "plain" | "icon",
  p: Palette,
  act: () => void,
): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = text;
  css(b, [
    ["all", "initial"],
    ["box-sizing", "border-box"],
    ["min-height", "44px"],
    ["padding", kind === "icon" ? "0" : "10px 14px"],
    ["border-radius", "10px"],
    ["font", "600 14px/20px system-ui, sans-serif"],
    ["text-align", "center"],
    ["cursor", "pointer"],
    ["color", kind === "primary" ? p.primaryText : p.text],
    ["background", kind === "primary" ? p.primary : kind === "plain" ? p.button : "transparent"],
    ...(kind === "icon"
      ? ([
          ["width", "44px"],
          ["font-size", "20px"],
        ] as Rules)
      : []),
  ]);
  // Only a real user's click: the page cannot press these by script.
  b.addEventListener("click", (e) => {
    if (e.isTrusted) act();
  });
  b.addEventListener("focus", () => css(b, [["outline", `2px solid ${p.primary}`]]));
  b.addEventListener("blur", () => css(b, [["outline", "none"]]));
  return b;
}

function text(doc: Document, s: string, rules: Rules): HTMLElement {
  const el = doc.createElement("div");
  el.textContent = s;
  css(el, [
    ["all", "initial"],
    ["display", "block"],
    ["font", "inherit"],
    ["color", "inherit"],
    ...rules,
  ]);
  return el;
}

export type DialogDeps = {
  doc: Document;
  win?: Pick<Window, "matchMedia">;
  strings: PillChatStrings;
};

/**
 * "Allow Li chat on <host>?": resolves to the choice. × , Escape or a click
 * outside is "dismiss" (a deny that stores nothing). Removes itself.
 */
export function trustDialog(d: DialogDeps & { host: string }): {
  result: Promise<TrustChoice>;
  remove(): void;
} {
  const t = d.strings;
  const p = palette(d.win);
  let done!: (c: TrustChoice) => void;
  const result = new Promise<TrustChoice>((resolve) => (done = resolve));
  const title = t.promptTitle.replace("{host}", d.host);
  let shell: Shell | null = null;
  const finish = (c: TrustChoice) => {
    shell?.remove();
    shell = null;
    done(c);
  };
  shell = modal(d.doc, p, title, () => finish("dismiss"));
  const head = d.doc.createElement("div");
  css(head, [
    ["all", "initial"],
    ["display", "flex"],
    ["align-items", "flex-start"],
    ["gap", "8px"],
  ]);
  const h = text(d.doc, title, [
    ["font", "600 16px/22px system-ui, sans-serif"],
    ["flex", "1"],
    ["overflow-wrap", "anywhere"],
    ["padding-top", "10px"],
  ]);
  h.setAttribute("role", "heading");
  const x = button(d.doc, "×", "icon", p, () => finish("dismiss"));
  x.setAttribute("aria-label", t.notNow);
  x.title = t.notNow;
  head.append(h, x);
  const body = text(d.doc, t.promptBody, [["color", p.muted]]);
  const warn = text(d.doc, t.promptWarn, [
    ["background", p.warnBg],
    ["color", p.warnText],
    ["padding", "8px 10px"],
    ["border-radius", "8px"],
  ]);
  warn.setAttribute("role", "note");
  const row = d.doc.createElement("div");
  css(row, [
    ["all", "initial"],
    ["display", "flex"],
    ["flex-direction", "column"],
    ["gap", "8px"],
  ]);
  const always = button(d.doc, t.allowAlways, "primary", p, () => finish("always"));
  row.append(
    always,
    button(d.doc, t.allowOnce, "plain", p, () => finish("once")),
    button(d.doc, t.neverHere, "plain", p, () => finish("never")),
  );
  shell.panel.append(head, body, warn, row);
  try {
    x.focus();
  } catch {}
  return {
    result,
    remove: () => finish("dismiss"),
  };
}

/**
 * The sites list: every host with a stored decision and a Forget button
 * (the revocation UI). Forget removes the decision; the prompt asks again.
 */
export function sitesDialog(
  d: DialogDeps & { store: TrustStore; onChange?: (host: string) => void },
): { remove(): void; closed: Promise<void> } {
  const t = d.strings;
  const p = palette(d.win);
  let closedResolve!: () => void;
  const closed = new Promise<void>((r) => (closedResolve = r));
  let shell: Shell | null = null;
  const close = () => {
    shell?.remove();
    shell = null;
    closedResolve();
  };
  shell = modal(d.doc, p, t.sitesTitle, close);
  const h = text(d.doc, t.sitesTitle, [["font", "600 16px/22px system-ui, sans-serif"]]);
  h.setAttribute("role", "heading");
  const list = d.doc.createElement("div");
  css(list, [
    ["all", "initial"],
    ["display", "flex"],
    ["flex-direction", "column"],
    ["gap", "4px"],
    ["font", "inherit"],
    ["color", "inherit"],
  ]);
  const label = (v: SiteDecision) => (v === "allow" ? t.sitesAllowed : t.sitesNever);
  const render = () => {
    list.replaceChildren();
    const rows = d.store.list();
    if (!rows.length) {
      list.append(text(d.doc, t.sitesEmpty, [["color", p.muted]]));
      return;
    }
    for (const [host, v] of rows) {
      const row = d.doc.createElement("div");
      css(row, [
        ["all", "initial"],
        ["display", "flex"],
        ["align-items", "center"],
        ["gap", "8px"],
        ["padding", "4px 0"],
        ["border-bottom", `1px solid ${p.line}`],
        ["font", "inherit"],
        ["color", "inherit"],
      ]);
      const name = text(d.doc, host, [
        ["flex", "1"],
        ["min-width", "0"],
        ["overflow-wrap", "anywhere"],
      ]);
      const state = text(d.doc, label(v), [
        ["color", p.muted],
        ["font-size", "13px"],
      ]);
      const forget = button(d.doc, t.forget, "plain", p, () => {
        d.store.forget(host);
        d.onChange?.(host);
        render();
      });
      forget.setAttribute("aria-label", `${t.forget}: ${host}`);
      row.append(name, state, forget);
      list.append(row);
    }
  };
  render();
  const closeBtn = button(d.doc, t.close, "primary", p, close);
  shell.panel.append(h, list, closeBtn);
  try {
    closeBtn.focus();
  } catch {}
  return { remove: close, closed };
}

/** The note where the frame cannot open (CSP frame-src): text and a link to lianki.com. */
export function blockedNote(d: DialogDeps & { origin: string }): () => void {
  const t = d.strings;
  const p = palette(d.win);
  const host = d.doc.createElement("div");
  css(host, [
    ["all", "initial"],
    ["display", "block"],
    ["position", "fixed"],
    ["right", "8px"],
    ["bottom", "8px"],
    ["z-index", "2147483647"],
  ]);
  const root = host.attachShadow({ mode: "closed" });
  const box = d.doc.createElement("div");
  box.setAttribute("role", "status");
  css(box, [
    ["all", "initial"],
    ["display", "flex"],
    ["gap", "8px"],
    ["align-items", "flex-start"],
    ["max-width", "min(320px, calc(100vw - 16px))"],
    ["padding", "10px 12px"],
    ["border-radius", "12px"],
    ["background", p.surface],
    ["color", p.text],
    ["border", `1px solid ${p.line}`],
    ["font", "13px/18px system-ui, sans-serif"],
  ]);
  const msg = text(d.doc, t.blocked, []);
  const link = d.doc.createElement("a");
  link.href = d.origin;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t.openLianki;
  css(link, [
    ["display", "block"],
    ["margin-top", "4px"],
    ["color", p.primary],
    ["text-decoration", "underline"],
  ]);
  msg.append(link);
  const remove = () => host.remove();
  const x = button(d.doc, "×", "icon", p, remove);
  x.setAttribute("aria-label", t.close);
  box.append(msg, x);
  root.append(box);
  (d.doc.documentElement ?? d.doc.body).append(host);
  return remove;
}
