/**
 * Every transactional mail Lianki sends, as one template each
 * (docs/mail-templates.md): its variables — the REQUIRED ones are locked: a
 * stored edit without them is refused — sample values for the editor, and the
 * built-in default source per language, made from the intlayer content files
 * (each string with its translator context line).
 *
 * `schema` is the version of a template's variable set. A stored edit records
 * the schema it was written for; when a template's variables change, bump it,
 * and every older edit stops applying (the built-in default is sent instead)
 * until someone saves a new one.
 *
 * Pure and client-safe: the /dev/templates editor imports it for its preview.
 */
import { INVITE_MAIL_SENDER } from "@/lib/referrals/email-invite-config";
import inviteDict from "@/lib/referrals/invite-mail.content";
import emailChangeDict from "./email-change-mail.content";
import { escapeCopy, type TemplateSource, type VarSpecs } from "./engine";
import { RTL_MAIL_LOCALES, type MailLocale } from "./locales";
import loginNoticeDict from "./login-notice-mail.content";
import signInDict from "./sign-in-mail.content";
import {
  ZH_HANT_EMAIL_CHANGE,
  ZH_HANT_INVITE,
  ZH_HANT_LOGIN_NOTICE,
  ZH_HANT_SIGN_IN,
} from "./zh-hant";

export const MAIL_TEMPLATE_IDS = [
  "signin-code",
  "signin-link",
  "login-notice",
  "email-confirm",
  "email-taken",
  "email-requested",
  "email-changed",
  "invite",
] as const;
export type MailTemplateId = (typeof MAIL_TEMPLATE_IDS)[number];

export const isMailTemplateId = (v: unknown): v is MailTemplateId =>
  typeof v === "string" && (MAIL_TEMPLATE_IDS as readonly string[]).includes(v);

/** The "not you? tell us" page the security mails link to. */
export const MAIL_CONTACT_URL = "https://lianki.com/contact";

export type SampleSet = "typical" | "long";
export const SAMPLE_SETS: readonly SampleSet[] = ["typical", "long"];

export type MailTemplateDef = {
  id: MailTemplateId;
  schema: number;
  /** For whoever edits it: when it is sent, to whom. English, dev-facing. */
  about: string;
  vars: VarSpecs;
  /** Values for the editor's preview and test send: never a real person's. */
  samples: Record<SampleSet, Record<string, string>>;
  builtin: (locale: MailLocale) => TemplateSource;
};

type Dict = { content: Record<string, unknown> };

/** A dictionary's strings in `locale` (zh-Hant from its own record); English where one is missing. */
export function copyOf<D extends Dict>(
  dict: D,
  zhHant: Record<keyof D["content"], string>,
  locale: MailLocale,
): Record<keyof D["content"], string> {
  const out = {} as Record<keyof D["content"], string>;
  for (const [k, node] of Object.entries(dict.content)) {
    const tr = (node as { translation: Record<string, string> }).translation;
    const key = k as keyof D["content"];
    out[key] = (locale === "zh-Hant" ? zhHant[key] : tr[locale]) ?? tr.en;
  }
  return out;
}

const MUTED = "color:oklch(0.45 0 0)";

/** The frame every mail shares: direction and language of `locale`, a readable column. */
function frame(locale: MailLocale, body: string): string {
  const dir = RTL_MAIL_LOCALES.has(locale) ? "rtl" : "ltr";
  return (
    `<div dir="${dir}" lang="${locale}" style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:16px;line-height:1.5;max-width:560px;margin:0 auto;padding:16px">` +
    body +
    `</div>`
  );
}

/** Escaped copy with `{var}` turned into a link to itself. */
const linkify = (copy: string, v: string) =>
  escapeCopy(copy).replace(`{${v}}`, `<a href="{${v}}">{${v}}</a>`);

const p = (s: string, style?: string) => `<p${style ? ` style="${style}"` : ""}>${s}</p>`;

const signInCopy = (l: MailLocale) => copyOf(signInDict, ZH_HANT_SIGN_IN, l);
const noticeCopy = (l: MailLocale) => copyOf(loginNoticeDict, ZH_HANT_LOGIN_NOTICE, l);
const changeCopy = (l: MailLocale) => copyOf(emailChangeDict, ZH_HANT_EMAIL_CHANGE, l);
export const inviteCopy = (l: MailLocale) => copyOf(inviteDict, ZH_HANT_INVITE, l);
export const loginNoticeCopy = noticeCopy;

const req = (kind: "url" | "text") => ({ kind, required: true });
const opt = (kind: "url" | "text") => ({ kind, required: false });

const signinCode: MailTemplateDef = {
  id: "signin-code",
  schema: 1,
  about:
    "The 6-digit code typed on the sign-in page. Sent when someone asks to sign in (or sign up) by email.",
  vars: { code: req("text") },
  samples: { typical: { code: "482913" }, long: { code: "000000" } },
  builtin: (l) => {
    const c = signInCopy(l);
    return {
      subject: c.codeSubject,
      text: [c.codeIntro, "{code}", "", c.validity, c.ignore].join("\n"),
      html: frame(
        l,
        p(escapeCopy(c.codeIntro)) +
          p("{code}", "font-size:28px;font-weight:bold;letter-spacing:6px") +
          p(`${escapeCopy(c.validity)}<br>${escapeCopy(c.ignore)}`, MUTED),
      ),
    };
  },
};

const signinLink: MailTemplateDef = {
  id: "signin-link",
  schema: 1,
  about: "The one-click sign-in link (magic link). Sent when someone asks to sign in by link.",
  vars: { url: req("url") },
  samples: {
    typical: { url: "https://lianki.com/api/auth/magic-link/verify?token=SAMPLE" },
    long: {
      url: "https://lianki.com/api/auth/magic-link/verify?token=SAMPLE-0123456789abcdef0123456789abcdef&callbackURL=%2Fwords",
    },
  },
  builtin: (l) => {
    const c = signInCopy(l);
    return {
      subject: c.linkSubject,
      text: [c.linkIntro, "", "{url}", "", c.validity, c.ignore].join("\n"),
      html: frame(
        l,
        p(escapeCopy(c.linkIntro)) +
          p(`<a href="{url}">${escapeCopy(c.linkButton)}</a>`) +
          p(`${escapeCopy(c.validity)}<br>${escapeCopy(c.ignore)}`, MUTED),
      ),
    };
  },
};

const loginNotice: MailTemplateDef = {
  id: "login-notice",
  schema: 1,
  about:
    "Security notice to the account after a sign-in from a browser it has not used before. Its time, location and browser lines and the 'not you' contact link are locked.",
  vars: {
    time: req("text"),
    location: req("text"),
    browser: req("text"),
    contactUrl: req("url"),
  },
  samples: {
    typical: {
      time: "2026-11-09 09:20 UTC",
      location: "Tokyo, 13, JP",
      browser: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15",
      contactUrl: MAIL_CONTACT_URL,
    },
    long: {
      time: "2026-12-31 23:59 UTC",
      location: "São Paulo, SP, BR",
      browser:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0 <b>not bold</b>",
      contactUrl: MAIL_CONTACT_URL,
    },
  },
  builtin: (l) => {
    const c = noticeCopy(l);
    const rows: [string, string][] = [
      [c.time, "{time}"],
      [c.location, "{location}"],
      [c.device, "{browser}"],
    ];
    return {
      subject: c.subject,
      text: [c.intro, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", c.ok, c.notYou].join("\n"),
      html: frame(
        l,
        p(escapeCopy(c.intro)) +
          `<table>${rows.map(([k, v]) => `<tr><td><b>${escapeCopy(k)}</b></td><td>${v}</td></tr>`).join("")}</table>` +
          p(`${escapeCopy(c.ok)}<br>${linkify(c.notYou, "contactUrl")}`),
      ),
    };
  },
};

const emailConfirm: MailTemplateDef = {
  id: "email-confirm",
  schema: 1,
  about: "Sent to a NEW address when an account asks to change its email: the confirm link.",
  vars: { url: req("url") },
  samples: {
    typical: { url: "https://lianki.com/my/profile/email-confirm#SAMPLE" },
    long: {
      url: "https://lianki.com/my/profile/email-confirm#SAMPLE.0123456789abcdef0123456789abcdef",
    },
  },
  builtin: (l) => {
    const c = changeCopy(l);
    return {
      subject: c.confirmSubject,
      text: [c.confirmIntro, "", "{url}", "", c.confirmValid, c.ignore].join("\n"),
      html: frame(
        l,
        p(escapeCopy(c.confirmIntro)) +
          p(`<a href="{url}">${escapeCopy(c.confirmButton)}</a>`) +
          p(`${escapeCopy(c.confirmValid)}<br>${escapeCopy(c.ignore)}`, MUTED),
      ),
    };
  },
};

const emailTaken: MailTemplateDef = {
  id: "email-taken",
  schema: 1,
  about:
    "Sent to an address someone tried to move an account to, when that address already belongs to an account. No variables.",
  vars: {},
  samples: { typical: {}, long: {} },
  builtin: (l) => {
    const c = changeCopy(l);
    return {
      subject: c.takenSubject,
      text: [c.takenBody, c.ignore].join("\n\n"),
      html: frame(l, p(escapeCopy(c.takenBody)) + p(escapeCopy(c.ignore))),
    };
  },
};

const changeNotice = (id: "email-requested" | "email-changed", about: string): MailTemplateDef => ({
  id,
  schema: 1,
  about,
  vars: { address: req("text"), contactUrl: req("url") },
  samples: {
    typical: { address: "n***@example.com", contactUrl: MAIL_CONTACT_URL },
    long: { address: "a-very-long-n***@subdomain.example.co.jp", contactUrl: MAIL_CONTACT_URL },
  },
  builtin: (l) => {
    const c = changeCopy(l);
    const [subject, body] =
      id === "email-requested"
        ? [c.requestedSubject, c.requestedBody]
        : [c.changedSubject, c.changedBody];
    return {
      subject,
      text: [body, c.notYou].join("\n\n"),
      html: frame(l, p(escapeCopy(body)) + p(linkify(c.notYou, "contactUrl"))),
    };
  },
});

const invite: MailTemplateDef = {
  id: "invite",
  schema: 1,
  about:
    "A Lianki user invites one friend by address (in the inviter's language). The invite link, the recipient's address, the inviter, and the unsubscribe and report links are locked (anti-spam rules).",
  vars: {
    inviter: req("text"),
    address: req("text"),
    inviteUrl: req("url"),
    unsubscribeUrl: req("url"),
    reportUrl: req("url"),
    extraDays: opt("text"),
    baseDays: opt("text"),
    totalDays: opt("text"),
    site: opt("text"),
    contactUrl: opt("url"),
    postal: opt("text"),
  },
  samples: {
    typical: {
      inviter: "Sample Friend",
      address: "friend@example.com",
      inviteUrl: "https://lianki.com/i/PREVIEW",
      unsubscribeUrl: "https://lianki.com/membership/invite-opt-out?lang=en#t=preview",
      reportUrl: "https://lianki.com/membership/invite-opt-out?lang=en#t=preview&report=1",
      extraDays: "30",
      baseDays: "90",
      totalDays: "120",
      site: "lianki.com",
      contactUrl: INVITE_MAIL_SENDER.contactUrl,
      postal: "",
    },
    long: {
      inviter: "Maximiliana Fernández-Oyelaran <b>",
      address: "someone.with.a.really.long.address@subdomain.example.co.jp",
      inviteUrl: "https://lianki.com/i/PREVIEW",
      unsubscribeUrl: "https://lianki.com/membership/invite-opt-out?lang=en#t=preview",
      reportUrl: "https://lianki.com/membership/invite-opt-out?lang=en#t=preview&report=1",
      extraDays: "30",
      baseDays: "90",
      totalDays: "120",
      site: "lianki.com",
      contactUrl: INVITE_MAIL_SENDER.contactUrl,
      postal: "1-2-3 Sample, Chiyoda-ku, Tokyo",
    },
  },
  builtin: (l) => {
    const c = inviteCopy(l);
    const postal = INVITE_MAIL_SENDER.postalAddress;
    const muted = MUTED;
    const text = [
      c.invitedBy,
      "",
      c.intro,
      "",
      c.offer,
      "",
      c.cta,
      "{inviteUrl}",
      "",
      "—",
      c.why,
      "",
      c.sentTo,
      c.unsubscribe,
      "{unsubscribeUrl}",
      "",
      c.report,
      "{reportUrl}",
      "",
      c.sender,
      c.contact,
      ...(postal ? ["{postal}"] : []),
    ].join("\n");
    const html = frame(
      l,
      p(escapeCopy(c.invitedBy), "font-weight:700;font-size:18px;margin:0 0 16px") +
        p(escapeCopy(c.intro)) +
        p(escapeCopy(c.offer)) +
        p(
          `<a href="{inviteUrl}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:oklch(0.45 0.198 22.3);color:oklch(1 0 0);font-weight:700;text-decoration:none">${escapeCopy(c.cta)}</a>`,
          "margin:24px 0",
        ) +
        p(`${escapeCopy(c.linkLine)}<br><a href="{inviteUrl}">{inviteUrl}</a>`, "font-size:14px") +
        `<hr style="border:none;border-top:1px solid oklch(0.85 0 0);margin:24px 0">` +
        p(escapeCopy(c.why), `font-size:13px;${muted}`) +
        p(
          `<span style="${muted}">${escapeCopy(c.sentTo).replace("{address}", "<bdi>{address}</bdi>")}</span><br><a href="{unsubscribeUrl}">${escapeCopy(c.unsubscribe)}</a> · <a href="{reportUrl}">${escapeCopy(c.report)}</a>`,
          "font-size:13px",
        ) +
        p(
          `${escapeCopy(c.sender)}<br>${linkify(c.contact, "contactUrl")}${postal ? "<br>{postal}" : ""}`,
          `font-size:13px;${muted}`,
        ),
    );
    return { subject: c.subject, text, html };
  },
};

export const MAIL_TEMPLATES: Record<MailTemplateId, MailTemplateDef> = {
  "signin-code": signinCode,
  "signin-link": signinLink,
  "login-notice": loginNotice,
  "email-confirm": emailConfirm,
  "email-taken": emailTaken,
  "email-requested": changeNotice(
    "email-requested",
    "Sent to an account's CURRENT address when a change of its email is requested.",
  ),
  "email-changed": changeNotice(
    "email-changed",
    "Sent to an account's OLD address once its email has been changed.",
  ),
  invite,
};

/** The locked (required) variables of a template, in declaration order. */
export const lockedVars = (id: MailTemplateId) =>
  Object.entries(MAIL_TEMPLATES[id].vars)
    .filter(([, s]) => s.required)
    .map(([n]) => n);
