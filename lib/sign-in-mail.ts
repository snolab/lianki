import { LOCALE_HEADER, localeFromAcceptLanguage, resolveLocale } from "@/lib/app-locale";

/**
 * Sign-in mail (code or link), in the reader's language.
 *
 * Localized, not bilingual: a Chinese user gets Chinese, everyone else
 * English. Both carry a plain-text part — a bare one-link HTML mail tends to
 * be filed as spam.
 */
export type MailLocale = "zh" | "en";

/** The request's app locale (middleware header), else Accept-Language. */
export function mailLocale(ctx?: { headers?: Headers | null } | null): MailLocale {
  const h = ctx?.headers;
  const locale =
    (h?.get(LOCALE_HEADER) && resolveLocale(h.get(LOCALE_HEADER))) ||
    localeFromAcceptLanguage(h?.get("accept-language") ?? null);
  return locale === "zh" ? "zh" : "en";
}

const COPY = {
  en: {
    brand: "Lianki",
    codeSubject: (otp: string) => `${otp} is your Lianki sign-in code`,
    codeIntro: "Your Lianki sign-in code:",
    linkSubject: "Sign in to Lianki",
    linkIntro: "Open this link to sign in to Lianki:",
    linkButton: "Sign in",
    validity: "Valid for 15 minutes.",
    ignore: "If you did not ask for this, you can ignore this email.",
  },
  zh: {
    brand: "炼記",
    codeSubject: (otp: string) => `${otp} 是你的炼記登录验证码`,
    codeIntro: "你的炼記（Lianki）登录验证码：",
    linkSubject: "登录炼記",
    linkIntro: "打开下面的链接登录炼記（Lianki）：",
    linkButton: "登录",
    validity: "15 分钟内有效。",
    ignore: "如果不是你本人操作，请忽略此邮件。",
  },
} as const;

export function signInMail(
  locale: MailLocale,
  what: { otp: string } | { url: string },
): { subject: string; text: string; html: string } {
  const c = COPY[locale];
  if ("otp" in what)
    return {
      subject: c.codeSubject(what.otp),
      text: [c.codeIntro, what.otp, "", c.validity, c.ignore].join("\n"),
      html:
        `<p>${c.codeIntro}</p>` +
        `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${what.otp}</p>` +
        `<p style="color:#888">${c.validity}<br>${c.ignore}</p>`,
    };
  return {
    subject: c.linkSubject,
    text: [c.linkIntro, "", what.url, "", c.validity, c.ignore].join("\n"),
    html:
      `<p>${c.linkIntro}</p>` +
      `<p><a href="${what.url}">${c.linkButton}</a></p>` +
      `<p style="color:#888">${c.validity}<br>${c.ignore}</p>`,
  };
}
