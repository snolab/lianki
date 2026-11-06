/**
 * The mails of an address change, in the reader's language (as lib/sign-in-mail.ts:
 * Chinese or English). `masked` is the other address, already masked.
 */
import type { MailLocale } from "@/lib/sign-in-mail";

const COPY = {
  en: {
    confirmSubject: "Confirm your new Lianki email",
    confirmIntro:
      "Someone asked to use this address for a Lianki account. Open this link to confirm it:",
    confirmButton: "Confirm this address",
    confirmValid: "Valid for 1 hour. Nothing changes until you confirm.",
    ignore: "If you did not ask for this, you can ignore this email.",
    takenSubject: "A Lianki email change was refused",
    takenBody:
      "Someone asked to move a Lianki account to this address, but it can't be used: it already belongs to an account. Nothing was changed. You can sign in with this address as usual.",
    requestedSubject: "A change of your Lianki email was requested",
    requestedBody: (m: string) =>
      `Someone signed in to your Lianki account asked to change its email to ${m}. It changes only once that address is confirmed.`,
    changedSubject: "Your Lianki email was changed",
    changedBody: (m: string) =>
      `Your Lianki account's email is now ${m}. This address no longer signs in to it.`,
    notYou: "If this wasn't you, contact us right away: https://lianki.com/contact",
  },
  zh: {
    confirmSubject: "确认你的炼記新邮箱",
    confirmIntro: "有人申请把这个地址用于炼記（Lianki）账户。打开下面的链接确认：",
    confirmButton: "确认这个地址",
    confirmValid: "1 小时内有效。确认之前不会有任何改动。",
    ignore: "如果不是你本人操作，请忽略此邮件。",
    takenSubject: "一次炼記邮箱更改被拒绝",
    takenBody:
      "有人申请把炼記账户改到这个地址，但这个地址无法使用：它已属于一个账户。没有任何改动。你可以照常用这个地址登录。",
    requestedSubject: "有人申请更改你的炼記邮箱",
    requestedBody: (m: string) =>
      `已登录你炼記账户的人申请把邮箱改为 ${m}。只有在那个地址确认后才会更改。`,
    changedSubject: "你的炼記邮箱已更改",
    changedBody: (m: string) => `你的炼記账户邮箱现在是 ${m}。这个地址不能再登录该账户。`,
    notYou: "如果不是你本人操作，请立即联系我们：https://lianki.com/contact",
  },
} as const;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plain = (subject: string, ...lines: string[]) => ({
  subject,
  text: lines.join("\n\n"),
  html: lines.map((l) => `<p>${esc(l)}</p>`).join(""),
});

export function emailConfirmMail(locale: MailLocale, url: string) {
  const c = COPY[locale];
  return {
    subject: c.confirmSubject,
    text: [c.confirmIntro, "", url, "", c.confirmValid, c.ignore].join("\n"),
    html:
      `<p>${esc(c.confirmIntro)}</p>` +
      `<p><a href="${esc(url)}">${esc(c.confirmButton)}</a></p>` +
      `<p style="color:#888">${esc(c.confirmValid)}<br>${esc(c.ignore)}</p>`,
  };
}

export function emailTakenMail(locale: MailLocale) {
  const c = COPY[locale];
  return plain(c.takenSubject, c.takenBody, c.ignore);
}

export function emailRequestedMail(locale: MailLocale, masked: string) {
  const c = COPY[locale];
  return plain(c.requestedSubject, c.requestedBody(masked), c.notYou);
}

export function emailChangedMail(locale: MailLocale, masked: string) {
  const c = COPY[locale];
  return plain(c.changedSubject, c.changedBody(masked), c.notYou);
}
