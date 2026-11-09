/**
 * The ONE layout every mail is sent in (docs/mail-templates.md, "Layout and
 * colours"). A template — built-in or a stored edit from /dev/templates — is
 * the body only; this wraps it at render time in the shared frame: the brand
 * heading, the label of a security notice, the body, and the footer that says
 * whether and how this kind of mail can be turned off (./kinds.ts).
 *
 * - Palette: seal-ink red is the primary (brand, buttons, links), gold the
 *   secondary (rules, the security label's frame), ink and paper the
 *   neutrals. Red is not a danger colour here: a security notice is marked by
 *   its own shield icon and label, never by red alone.
 * - The tokens are oklch() like everywhere else; the mail renderer converts
 *   them to hex (./color.ts), because most mail clients understand neither
 *   oklch() nor light-dark(). The one allowed exception to the oklch rule.
 * - Table layout, inline styles (what Outlook and Gmail keep), a dark-mode
 *   @media block for the clients that honour it, AA contrast in both themes
 *   (unit-tested).
 * - Fonts: the site's faces (LXGW WenKai TC for the body, Yuji Syuku for the
 *   brand) through a web-font link, with system fallbacks, because many
 *   clients block web fonts.
 *
 * The shell is code, not template: the editor cannot remove the footer or
 * the unsubscribe link, as with the List-Unsubscribe headers. Pure and
 * client-safe (the /dev/templates preview renders through it).
 */
import { hexifyOklch } from "./color";
import type { MailTemplateId } from "./defs";
import { MAIL_KINDS } from "./kinds";
import { RTL_MAIL_LOCALES, type MailLocale } from "./locales";
import layoutDict from "./mail-layout.content";
import { ZH_HANT_MAIL_LAYOUT } from "./zh-hant";
import { escapeHtml } from "./engine";

/** Where the security footer sends the reader to turn a notice off. */
export const MAIL_PREFERENCES_URL = "https://lianki.com/my/preferences#mail";
const SITE = "lianki.com";
const SITE_URL = "https://lianki.com";

/** Light and dark tokens, oklch. Converted to hex at render (./color.ts). */
export const MAIL_TOKENS = {
  light: {
    page: "oklch(0.95 0.018 82)",
    card: "oklch(0.99 0.006 85)",
    ink: "oklch(0.21 0.01 60)",
    muted: "oklch(0.45 0.02 68)",
    seal: "oklch(0.53 0.207 22.3)",
    onSeal: "oklch(0.99 0.005 85)",
    gold: "oklch(0.72 0.12 80)",
    goldSoft: "oklch(0.95 0.045 88)",
    goldInk: "oklch(0.4 0.08 70)",
    codeBg: "oklch(0.95 0.018 82)",
  },
  dark: {
    page: "oklch(0.15 0.008 60)",
    card: "oklch(0.21 0.01 60)",
    ink: "oklch(0.93 0.015 85)",
    muted: "oklch(0.76 0.02 75)",
    seal: "oklch(0.74 0.15 22)",
    onSeal: "oklch(0.99 0.005 85)",
    gold: "oklch(0.7 0.11 80)",
    goldSoft: "oklch(0.28 0.04 80)",
    goldInk: "oklch(0.87 0.09 85)",
    codeBg: "oklch(0.27 0.013 62)",
  },
} as const;
/** The button keeps the seal in dark mode too: white on seal passes AA in both. */
export const MAIL_BUTTON = { bg: "oklch(0.53 0.207 22.3)", fg: "oklch(0.99 0.005 85)" } as const;

const L = MAIL_TOKENS.light;

/** Body faces: the site's, then the system's CJK and Latin faces. */
export const MAIL_FONT =
  "'LXGW WenKai TC','PingFang SC','PingFang TC','Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans CJK SC','Noto Sans JP','Microsoft YaHei',system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
/** The brand heading's brush face, then serif CJK faces. */
export const MAIL_BRUSH_FONT =
  "'Yuji Syuku','LXGW WenKai TC','Hiragino Mincho ProN','Songti SC','Noto Serif CJK SC','Noto Serif JP',Georgia,serif";
const FONT_LINKS = [
  "https://cdn.jsdelivr.net/npm/lxgw-wenkai-tc-web@1.522.0/lxgwwenkaitc-regular/result.css",
  "https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap",
];

// ── Styles the built-in bodies use (classes let the dark block repaint them) ──

/** A muted line (validity, "ignore this"). */
export const MUTED_ATTR = `class="lk-muted" style="color:${L.muted}"`;
/** A link inside the body. */
export const LINK_STYLE = `color:${L.seal};text-decoration:underline`;
/** The primary button: seal red, white text. */
export const BUTTON_ATTR = `class="lk-btn" style="display:inline-block;padding:12px 24px;border-radius:8px;background:${MAIL_BUTTON.bg};color:${MAIL_BUTTON.fg};font-weight:700;text-decoration:none"`;
/** The sign-in code box. */
export const CODE_ATTR = `class="lk-code" style="display:inline-block;padding:10px 18px;border-radius:8px;background:${L.codeBg};color:${L.ink};font-size:30px;font-weight:700;letter-spacing:6px;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace"`;

type Copy = Record<keyof (typeof layoutDict)["content"], string>;
function layoutCopy(locale: MailLocale): Copy {
  const out = {} as Copy;
  for (const [k, node] of Object.entries(layoutDict.content)) {
    const tr = (node as { translation: Record<string, string> }).translation;
    out[k as keyof Copy] =
      (locale === "zh-Hant" ? ZH_HANT_MAIL_LAYOUT[k as keyof Copy] : tr[locale]) ?? tr.en;
  }
  return out;
}

/** The dark repaint, under `scope` (an @media block, or the preview's `.lk-dark` root). */
function darkRules(prefix: string): string {
  const d = MAIL_TOKENS.dark;
  const r = (sel: string, decl: string) =>
    sel
      .split(",")
      .map((s) => `${prefix}${s.trim()}`)
      .join(",") + `{${decl}}`;
  return [
    r(".lk-page", `background:${d.page}!important`),
    r(".lk-card", `background:${d.card}!important`),
    r(
      ".lk-body,.lk-body p,.lk-body td,.lk-body th,.lk-body li,.lk-body b,.lk-body strong",
      `color:${d.ink}!important`,
    ),
    r(".lk-body .lk-muted,.lk-foot,.lk-foot td,.lk-foot p", `color:${d.muted}!important`),
    r(".lk-body a,.lk-foot a,.lk-brand", `color:${d.seal}!important`),
    r(
      ".lk-body a.lk-btn",
      `background:${MAIL_BUTTON.bg}!important;color:${MAIL_BUTTON.fg}!important`,
    ),
    r(".lk-code", `background:${d.codeBg}!important;color:${d.ink}!important`),
    r(
      ".lk-badge",
      `background:${d.goldSoft}!important;color:${d.goldInk}!important;border-color:${d.gold}!important`,
    ),
    r(".lk-rule", `border-color:${d.gold}!important`),
    r(".lk-row", `border-color:${d.gold}!important`),
  ].join("");
}

const STYLE =
  `:root{color-scheme:light dark;supported-color-schemes:light dark}` +
  `body{margin:0;padding:0;-webkit-text-size-adjust:100%}` +
  `a{color:${L.seal}}` +
  `@media (prefers-color-scheme: dark){${darkRules("")}}` +
  // The /dev/templates and /dev/mails previews switch themes with this class.
  darkRules(".lk-dark ") +
  // Outlook.com's dark mode tags the elements it repaints.
  darkRules("[data-ogsc] ");

export type ShellInput = {
  id: MailTemplateId;
  locale: MailLocale;
  brand: string;
  subject: string;
  /** The rendered body (template output). */
  html: string;
  text: string;
  /** The one-click page of an `optional` kind with a per-user token (./unsubscribe-token.ts). */
  unsubscribeUrl?: string;
};

/** The footer: whether and how this kind of mail can be turned off. */
function footer(i: ShellInput, c: Copy): { html: string; text: string } {
  const kind = MAIL_KINDS[i.id];
  const brandOf = (s: string) => s.replace(/\{brand\}/g, i.brand);
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="${LINK_STYLE}">${escapeHtml(label)}</a>`;
  if (kind.optOut === "preferences") {
    const [before, after = ""] = c.footerSecurity.split("{link}");
    return {
      html: escapeHtml(before) + link(MAIL_PREFERENCES_URL, c.preferencesLink) + escapeHtml(after),
      text: `${before}${c.preferencesLink} (${MAIL_PREFERENCES_URL})${after}`,
    };
  }
  if (kind.optOut === "one-click" && i.unsubscribeUrl)
    return {
      html: `${escapeHtml(c.footerOptional)} ${link(i.unsubscribeUrl, c.unsubscribe)}`,
      text: `${c.footerOptional} ${c.unsubscribe}: ${i.unsubscribeUrl}`,
    };
  // The invite carries its own opt-out footer in the body (anti-spam rules).
  if (kind.optOut === "invite-address") return { html: "", text: "" };
  const line = brandOf(c.footerRequired);
  return { html: escapeHtml(line), text: line };
}

/** The mail as sent: the body in the shared layout, every oklch() as hex. */
export function mailShell(i: ShellInput): { html: string; text: string } {
  const c = layoutCopy(i.locale);
  const dir = RTL_MAIL_LOCALES.has(i.locale) ? "rtl" : "ltr";
  const align = dir === "rtl" ? "right" : "left";
  const security = MAIL_KINDS[i.id].class === "security";
  const foot = footer(i, c);

  const badge = security
    ? `<tr><td style="padding:0 28px 4px" align="${align}">` +
      `<span class="lk-badge" style="display:inline-block;padding:4px 12px;border:1px solid ${L.gold};border-radius:999px;background:${L.goldSoft};color:${L.goldInk};font-size:14px;font-weight:700;line-height:1.4">` +
      `<span aria-hidden="true">&#128737;&#65039;</span> ${escapeHtml(c.securityLabel)}</span></td></tr>`
    : "";

  const html =
    `<!doctype html><html lang="${i.locale}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<title>${escapeHtml(i.subject)}</title>` +
    FONT_LINKS.map((h) => `<link rel="stylesheet" href="${h}">`).join("") +
    `<style>${STYLE}</style></head>` +
    `<body class="lk-page" style="margin:0;padding:0;background:${L.page}">` +
    `<table role="presentation" class="lk-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.page}" style="background:${L.page}"><tr>` +
    `<td align="center" style="padding:24px 12px">` +
    `<table role="presentation" class="lk-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.card}" ` +
    `style="max-width:560px;background:${L.card};border-top:4px solid ${L.seal};border-radius:4px">` +
    `<tr><td dir="${dir}" align="${align}" style="padding:22px 28px 10px">` +
    `<a href="${SITE_URL}" class="lk-brand" style="font-family:${MAIL_BRUSH_FONT};font-size:28px;line-height:1.2;color:${L.seal};text-decoration:none">${escapeHtml(i.brand)}</a>` +
    `</td></tr>` +
    `<tr><td style="padding:0 28px 14px"><div class="lk-rule" style="border-top:1px solid ${L.gold};height:0;line-height:0;font-size:0">&nbsp;</div></td></tr>` +
    badge +
    `<tr><td class="lk-body" dir="${dir}" align="${align}" style="padding:4px 28px 20px;font-family:${MAIL_FONT};font-size:16px;line-height:1.6;color:${L.ink}">` +
    i.html +
    `</td></tr>` +
    `<tr><td class="lk-foot" dir="${dir}" align="${align}" style="padding:14px 28px 22px;border-top:1px solid ${L.gold};font-family:${MAIL_FONT};font-size:13px;line-height:1.5;color:${L.muted}">` +
    (foot.html ? `${foot.html}<br>` : "") +
    `<a href="${SITE_URL}" style="${LINK_STYLE}">${SITE}</a>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = foot.text ? `${i.text}\n\n—\n${foot.text}` : i.text;
  return { html: hexifyOklch(html), text };
}

/**
 * A rendered mail for a preview frame (/dev/templates, /dev/mails, the render
 * script): the shell's own dark rules switched on with `.lk-dark`, because a
 * sandboxed frame cannot be told the reader's colour scheme.
 */
export function previewDoc(html: string, dark: boolean): string {
  if (!/^<!doctype html>/i.test(html)) return html;
  return html.replace(
    /^<!doctype html><html([^>]*)>/i,
    `<!doctype html><html$1 class="${dark ? "lk-dark" : "lk-light"}" style="color-scheme:${dark ? "dark" : "light"}">`,
  );
}
