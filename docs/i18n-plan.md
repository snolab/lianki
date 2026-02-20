# Lianki i18n Plan

## Table of Contents

1. [Target Languages](#1-target-languages)
2. [Library Comparison](#2-library-comparison)
3. [Recommended Choice](#3-recommended-choice)
4. [Architecture Overview](#4-architecture-overview)
5. [Complete String Inventory](#5-complete-string-inventory)
6. [Implementation Steps](#6-implementation-steps)
7. [Translation Strategy](#7-translation-strategy)
8. [SEO Considerations](#8-seo-considerations)
9. [Locale Detection Priority](#9-locale-detection-priority)
10. [Appendix](#10-appendix)

---

## 1. Target Languages

Top 15 most spoken languages by total speakers (native + second-language):

| #   | Language         | Locale Code | Script Direction | Notes                                              |
| --- | ---------------- | ----------- | ---------------- | -------------------------------------------------- |
| 1   | English          | `en`        | LTR              | Default / source language                          |
| 2   | Mandarin Chinese | `zh`        | LTR              | Simplified; `lang="zh-Hans"` on `<html>`           |
| 3   | Hindi            | `hi`        | LTR              | Devanagari script                                  |
| 4   | Spanish          | `es`        | LTR              |                                                    |
| 5   | French           | `fr`        | LTR              |                                                    |
| 6   | Standard Arabic  | `ar`        | **RTL**          | Requires `dir="rtl"` + mirrored layout             |
| 7   | Bengali          | `bn`        | LTR              |                                                    |
| 8   | Portuguese       | `pt`        | LTR              | Brazilian (`pt-BR`) is the dominant online variant |
| 9   | Russian          | `ru`        | LTR              | Cyrillic script                                    |
| 10  | Urdu             | `ur`        | **RTL**          | Naskh script; shares vocabulary with Hindi         |
| 11  | Indonesian       | `id`        | LTR              | Latin script; mutually intelligible with Malay     |
| 12  | German           | `de`        | LTR              |                                                    |
| 13  | Japanese         | `ja`        | LTR (horizontal) | CJK; may need CJK font fallbacks                   |
| 14  | Swahili          | `sw`        | LTR              | Lingua franca of East/Central Africa               |
| 15  | Marathi          | `mr`        | LTR              | Devanagari script (same as Hindi)                  |

**RTL languages:** Arabic (`ar`) and Urdu (`ur`) require `dir="rtl"` on the `<html>` element and mirrored Tailwind utilities (`rtl:` variant prefix).

---

## 2. Library Comparison

Four candidates evaluated for Next.js 15 App Router:

### 2.1 Comparison Table

| Criterion                    | **Intlayer** ✅                                                                  | **next-intl**                                                         | **i18next + react-i18next**                                  | **Paraglide JS (inlang)**                              |
| ---------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| **Status**                   | **Currently installed**                                                          | Alternative option                                                    | Alternative option                                           | Alternative option                                     |
| **TypeScript safety**        | Excellent — inline `t()` with full autocomplete; type-safe content objects       | Excellent — `useTranslations` infers keys via TS plugin               | Good — types provided; needs codegen for key inference       | Excellent — compiler generates typed functions         |
| **App Router / RSC support** | First-class — `getIntlayer()` works in RSC; `useIntlayer()` in Client Components | First-class — `getTranslations` for RSC; `useTranslations` for Client | Limited — client-only; RSC requires `createInstance` wrapper | Good — generated functions work in both RSC and Client |
| **Bundle size**              | ~15 kB gzip                                                                      | ~13 kB gzip                                                           | ~33 kB gzip                                                  | Near-zero (compile-time)                               |
| **Content authoring**        | Inline TypeScript — translations live in `.content.ts` files next to components  | External JSON — `messages/[locale].json`                              | External JSON — flexible structure                           | External files — generates functions                   |
| **Locale-aware routing**     | Built-in middleware + `IntlayerServerProvider`                                   | Built-in `createMiddleware` + locale-aware `Link`                     | None built-in                                                | None built-in                                          |
| **Translator tooling**       | Intlayer Editor (VS Code extension) + export to JSON/CSV                         | Works with any JSON editor; Crowdin/Lokalise adapters                 | Best-in-class integrations                                   | Inlang Editor (VS Code + web IDE)                      |
| **Pluralization / ICU**      | Full ICU MessageFormat support                                                   | Full ICU MessageFormat built-in                                       | Full ICU via `i18next-icu` plugin                            | Basic plurals; ICU via plugin                          |
| **Ecosystem maturity**       | Newer; growing; strong Next.js focus                                             | Actively maintained; strong Next.js focus                             | Most widely used; long track record                          | Newer; smaller community                               |
| **Learning curve**           | Low — inline `t()` pattern is intuitive                                          | Low for Next.js developers                                            | Moderate — broad API surface                                 | Low for simple cases                                   |

### 2.2 Pros / Cons Summary

**Intlayer** (currently installed)

- Pros: TypeScript-first; translations live next to components (`.content.ts` files); excellent autocomplete; RSC + Client Component support out of the box; already integrated with blog.
- Cons: Smaller ecosystem than i18next/next-intl; exporting for translators requires extra tooling; harder for non-developers to contribute translations directly.

**next-intl**

- Pros: Minimal boilerplate for App Router; best RSC/Server Action ergonomics; JSON-based (easier for translators); `createMiddleware` handles locale routing; well-documented.
- Cons: Slightly smaller ecosystem than i18next; TS key inference requires plugin setup; requires migration from existing Intlayer setup.

**i18next + react-i18next**

- Pros: Largest ecosystem; most translator platform integrations; battle-tested in enterprise apps; flexible for non-Next.js code.
- Cons: Heaviest bundle; client-side by default (RSC support is awkward); no routing helpers; requires migration from Intlayer.

**Paraglide JS**

- Pros: Zero-cost runtime; best dead-code elimination; fully type-safe without plugins; inlang Editor for translators.
- Cons: Smaller community; fewer docs for complex interpolation; no built-in routing; unfamiliar function-based API; requires migration.

---

## 3. Current Setup & Recommended Path

**Current state:** Lianki uses **Intlayer** (`next-intlayer` v8.1.2) with 3 locales (`en`, `zh`, `ja`).

**Recommendation: Continue with Intlayer and expand to 15 locales**

Rationale:

- Intlayer is already integrated and working well for the landing page and blog.
- The inline `.content.ts` pattern provides excellent TypeScript autocomplete and keeps translations close to components.
- Expanding from 3→15 locales requires only updating `intlayer.config.ts` and adding translation keys to existing `.content.ts` files.
- Migration to next-intl or another library would require rewriting all existing translations and component integration.
- For Lianki's ~53 UI strings, the Intlayer approach is manageable and provides a superior developer experience.

**Alternative consideration:** If the project grows significantly and translator collaboration becomes a bottleneck, consider migrating to **next-intl** (JSON-based workflow is easier for non-developer translators via Crowdin/Weblate).

---

## 4. Architecture Overview

### 4.1 Current Directory Structure (Intlayer)

```
lianki/
├── app/
│   ├── page.tsx                      # Landing page (uses Intlayer)
│   ├── page.content.ts               # ✅ Landing page translations (en, zh, ja)
│   ├── layout.tsx                    # Root layout
│   ├── [locale]/                     # ✅ Blog locale routes
│   │   ├── layout.tsx                # Locale layout with IntlayerServerProvider
│   │   └── blog/
│   │       ├── page.tsx              # Blog index
│   │       └── [slug]/page.tsx       # Blog post
│   ├── list/page.tsx                 # ❌ Not yet translated
│   ├── add-note/page.tsx             # ❌ Not yet translated
│   ├── profile/page.tsx              # ❌ Not yet translated
│   ├── auth/logout/page.tsx          # ❌ Not yet translated
│   ├── ContactForm.tsx               # ❌ Not yet translated
│   └── api/                          # No i18n needed
│
├── intlayer.config.ts                # ✅ Current: locales: ["en", "zh", "ja"]
├── middleware.ts                     # ✅ Uses intlayerMiddleware
└── next.config.mjs                   # ✅ Wrapped with withIntlayer()
```

### 4.2 Target Directory Structure (15 Locales)

```
lianki/
├── app/
│   ├── [locale]/                     # EXPAND: all app routes move here
│   │   ├── layout.tsx                # UPDATE: add RTL support, expand locale list
│   │   ├── page.tsx                  # MOVE from app/page.tsx
│   │   ├── page.content.ts           # UPDATE: add 12 more locales to existing file
│   │   ├── list/
│   │   │   ├── page.tsx              # MOVE from app/list/page.tsx
│   │   │   └── page.content.ts       # CREATE: list page translations
│   │   ├── add-note/
│   │   │   ├── page.tsx              # MOVE from app/add-note/page.tsx
│   │   │   └── page.content.ts       # CREATE: add-note translations
│   │   ├── profile/
│   │   │   ├── page.tsx              # MOVE from app/profile/page.tsx
│   │   │   └── page.content.ts       # CREATE: profile translations
│   │   ├── auth/logout/
│   │   │   └── page.tsx              # MOVE from app/auth/logout/page.tsx
│   │   ├── components/
│   │   │   ├── ContactForm.tsx       # MOVE from app/ContactForm.tsx
│   │   │   └── ContactForm.content.ts # CREATE: contact form translations
│   │   └── blog/                     # EXISTING (already in [locale])
│   │       ├── page.tsx
│   │       └── [slug]/page.tsx
│   ├── layout.tsx                    # MINIMAL: root shell
│   └── api/                          # UNCHANGED
│
├── intlayer.config.ts                # UPDATE: locales array to 15 languages + RTL config
├── middleware.ts                     # UPDATE: add RTL locale handling
├── next.config.mjs                   # UNCHANGED (already uses withIntlayer)
└── scripts/
    └── translate-messages.ts         # NEW: machine translation bootstrap script
```

### 4.3 Key Configuration Files (Intlayer)

**`intlayer.config.ts`** (UPDATE: expand locale list)

```ts
import type { IntlayerConfig } from "intlayer";

const config: IntlayerConfig = {
  internationalization: {
    locales: [
      "en",
      "zh",
      "hi",
      "es",
      "fr",
      "ar",
      "bn",
      "pt",
      "ru",
      "ur",
      "id",
      "de",
      "ja",
      "sw",
      "mr",
    ],
    defaultLocale: "en",
  },
  routing: {
    // Use URL prefix for all routes: /en/*, /zh/*, etc.
    mode: "prefix-default-locale", // or "prefix-only"
  },
};

export default config;
```

**`middleware.ts`** (UPDATE: add RTL handling)

```ts
import { intlayerMiddleware } from "next-intlayer/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const BLOG_LOCALES = [
  "en",
  "zh",
  "hi",
  "es",
  "fr",
  "ar",
  "bn",
  "pt",
  "ru",
  "ur",
  "id",
  "de",
  "ja",
  "sw",
  "mr",
];
const DEFAULT_LOCALE = "en";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Redirect /blog/* → /en/blog/*
  if (pathname === "/blog" || pathname.startsWith("/blog/")) {
    return NextResponse.redirect(new URL(`/${DEFAULT_LOCALE}${pathname}`, request.url));
  }

  // Redirect legacy /cn/* → /zh/*
  if (pathname === "/cn" || pathname.startsWith("/cn/")) {
    return NextResponse.redirect(new URL(pathname.replace(/^\/cn/, "/zh"), request.url));
  }

  // Redirect bare locale paths to blog index
  const bare = pathname.slice(1);
  if (BLOG_LOCALES.includes(bare) && pathname.split("/").length === 2) {
    return NextResponse.redirect(new URL(`${pathname}/blog`, request.url));
  }

  // Intlayer: detect locale from Accept-Language / cookie
  return intlayerMiddleware(request);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.user\\.js).*)"],
};
```

**`app/[locale]/layout.tsx`** (UPDATE: add RTL + expand lang map)

```tsx
import type { Metadata } from "next";
import { IntlayerServerProvider } from "next-intlayer/server";

const RTL_LOCALES = ["ar", "ur"];

// BCP47 lang tags for the HTML lang attribute
const LANG_TAG: Record<string, string> = {
  en: "en",
  zh: "zh-Hans",
  ja: "ja",
  hi: "hi",
  es: "es",
  fr: "fr",
  ar: "ar",
  bn: "bn",
  pt: "pt",
  ru: "ru",
  ur: "ur",
  id: "id",
  de: "de",
  sw: "sw",
  mr: "mr",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return { other: { "html-lang": LANG_TAG[locale] ?? locale } };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const lang = LANG_TAG[locale] ?? locale;
  const dir = RTL_LOCALES.includes(locale) ? "rtl" : "ltr";

  return (
    <IntlayerServerProvider locale={locale}>
      <div lang={lang} dir={dir} className="min-h-screen">
        {children}
      </div>
    </IntlayerServerProvider>
  );
}
```

**Example: `app/[locale]/page.content.ts`** (Intlayer translation pattern)

```ts
import { t, type DeclarationContent } from "intlayer";

const landingContent = {
  key: "landing-page",
  content: {
    hero: {
      title: t({
        en: "Supercharge Your Learning with Spaced Repetition",
        zh: "用间隔重复提升你的学习效率",
        ja: "間隔反復で学習を加速する",
        hi: "अंतराल पुनरावृत्ति के साथ अपनी सीखने की क्षमता बढ़ाएं",
        es: "Potencia tu aprendizaje con repetición espaciada",
        fr: "Boostez votre apprentissage avec la répétition espacée",
        ar: "عزز تعلمك بالتكرار المتباعد",
        // ... add all 15 locales
      }),
    },
  },
} satisfies DeclarationContent;

export default landingContent;
```

**Usage in Server Component** (`app/[locale]/page.tsx`)

```tsx
import { getIntlayer } from "intlayer";
import { getLocale } from "next-intlayer/server";

export default async function Page() {
  const locale = await getLocale();
  const { hero } = getIntlayer("landing-page", locale);
  return <h1>{hero.title}</h1>;
}
```

**Usage in Client Component** (`app/[locale]/components/ContactForm.tsx`)

```tsx
"use client";
import { useIntlayer } from "next-intlayer";

export default function ContactForm() {
  const { nameLabel, emailLabel } = useIntlayer("contact-form");
  return <input placeholder={nameLabel} />;
}
```

---

## 5. Complete String Inventory

All user-facing strings organized by page/component. Listed here as a reference (actual implementation uses Intlayer `.content.ts` files with `t()` function):

```json
{
  "meta": {
    "title": "Lianki",
    "description": "Spaced repetition learning with the FSRS algorithm"
  },

  "common": {
    "appName": "Lianki",
    "backToHome": "Back to Home",
    "signOut": "Sign out",
    "profile": "Profile",
    "na": "N/A"
  },

  "nav": {
    "goToApp": "Go to App",
    "installUserscript": "Install user script"
  },

  "landing": {
    "heroHeading": "Supercharge Your Learning with Spaced Repetition",
    "heroSubtitle": "Lianki is a modern, open-source spaced repetition system designed for efficient flashcard review and long-term memorization.",
    "heroCta": "Get Started for Free",

    "featuresHeading": "Key Features",
    "feature1Title": "FSRS Algorithm",
    "feature1Desc": "Utilizes the powerful FSRS algorithm for optimal review scheduling.",
    "feature2Title": "Browser Integration",
    "feature2Desc": "Add flashcards from any webpage with our Tampermonkey userscript.",
    "feature3Title": "Multi-User Support",
    "feature3Desc": "Sign in with Email, GitHub, or Google and keep your learning progress private.",

    "howItWorksHeading": "How It Works",
    "step1LinkText": "Install the userscript",
    "step1Suffix": "in your browser (Tampermonkey or Violentmonkey required).",
    "step2": "Use keyboard shortcuts (e.g., Alt+F) to add a webpage as a flashcard.",
    "step3": "Review your due cards daily with our simple interface.",
    "step4": "The FSRS algorithm schedules the next review based on your performance.",

    "footer": "Lianki is an open-source project.",
    "viewOnGithub": "View on GitHub"
  },

  "contact": {
    "heading": "Contact Us",
    "successMessage": "Message sent! We'll get back to you soon.",
    "errorMessage": "Something went wrong. Please try again.",

    "nameLabel": "Name",
    "namePlaceholder": "Your name",
    "emailLabel": "Email",
    "emailPlaceholder": "you@example.com",
    "phoneLabel": "Phone",
    "phoneOptional": "(optional)",
    "phonePlaceholder": "+1 234 567 8900",
    "messageLabel": "Message",
    "messageOptional": "(optional)",
    "messagePlaceholder": "Tell us what you'd like to learn...",

    "template1": "I want to learn a language faster",
    "template2": "I want to learn an instrument faster",
    "template3": "I want to learn skills faster",

    "submitIdle": "Send Message",
    "submitLoading": "Sending..."
  },

  "list": {
    "nextCard": "Next card",
    "totalCards": "Total cards:",
    "dueCards": "Due cards:",
    "installUserscript": "Install user script"
  },

  "addNote": {
    "adding": "Adding... {url}"
  },

  "profile": {
    "heading": "Profile",
    "userInfoHeading": "User Information",
    "nameLabel": "Name:",
    "emailLabel": "Email:",
    "avatarLabel": "Avatar:",
    "avatarAlt": "User avatar",
    "sessionHeading": "Session Details"
  },

  "logout": {
    "buttonLabel": "logout"
  }
}
```

### String Count by Page

| Page / Component                 | Strings |
| -------------------------------- | ------- |
| Landing (`page.tsx`)             | 15      |
| Contact form (`ContactForm.tsx`) | 16      |
| List page (`list/page.tsx`)      | 4       |
| Add-note page                    | 1       |
| Profile page                     | 7       |
| Logout page                      | 1       |
| Common / nav                     | 7       |
| Metadata                         | 2       |
| **Total**                        | **~53** |

---

## 6. Implementation Steps

Steps are ordered by dependency. Each is a discrete, independently mergeable unit.

### Step 1 — Install next-intl

```bash
bun add next-intl
```

### Step 2 — Create i18n configuration

Create `i18n/routing.ts` with the full 15-locale list (see Section 4.2).
Create `i18n/request.ts` with `getRequestConfig` (see Section 4.2).

### Step 3 — Create the English source message file

Create `messages/en.json` using the string inventory from Section 5. This is the canonical source.

### Step 4 — Update `next.config.mjs`

Wrap the export with `createNextIntlPlugin("./i18n/request.ts")`.

### Step 5 — Replace `middleware.ts`

Replace the current file with the next-intl `createMiddleware` version (see Section 4.2). Preserve the `/blog → /en/blog` redirect logic.

### Step 6 — Create `app/[locale]/layout.tsx`

Create the full locale layout with `<html lang>`, `dir`, `<body>`, and `<NextIntlClientProvider>`. Import `globals.css` here (remove from root layout).

### Step 7 — Simplify root `app/layout.tsx`

Remove `<html>` and `<body>` — they now live in the locale layout. Reduce to a fragment wrapper.

### Step 8 — Move routes under `app/[locale]/`

Move each page to its locale-prefixed path:

- `app/page.tsx` → `app/[locale]/page.tsx`
- `app/list/page.tsx` → `app/[locale]/list/page.tsx`
- `app/add-note/page.tsx` → `app/[locale]/add-note/page.tsx`
- `app/profile/page.tsx` → `app/[locale]/profile/page.tsx`
- `app/auth/logout/page.tsx` → `app/[locale]/auth/logout/page.tsx`

### Step 9 — Translate Server Components

In each RSC page, replace hardcoded strings with `getTranslations`:

```tsx
import { getTranslations } from "next-intl/server";

export default async function LandingPage() {
  const t = await getTranslations("landing");
  return <h2>{t("heroHeading")}</h2>;
}
```

### Step 10 — Translate Client Components

In `ContactForm.tsx`, use `useTranslations`:

```tsx
"use client";
import { useTranslations } from "next-intl";

export default function ContactForm() {
  const t = useTranslations("contact");
  // replace string literals with t("key")
}
```

### Step 11 — Update all internal links

Replace bare `href="/list"` etc. with next-intl's locale-aware `Link` and `redirect`:

```tsx
import { Link } from "@/i18n/routing"; // locale-prefixed automatically
// <Link href="/list"> → /en/list, /zh/list, etc.
```

### Step 12 — Add locale-aware metadata per page

In each page's `generateMetadata`, use translated strings and hreflang alternates (see Section 8).

### Step 13 — Add RTL CSS support

In `tailwind.config.ts`, ensure the `rtl:` variant is enabled (Tailwind v3 includes it by default when content paths are set). Add any custom RTL overrides to `app/globals.css`.

### Step 14 — Add locale switcher UI component

Create `app/[locale]/components/LocaleSwitcher.tsx`. Render locale links in the landing page header and the list page nav. On locale change, set the `NEXT_LOCALE` cookie and navigate.

### Step 15 — Bootstrap machine translations

Run `scripts/translate-messages.ts` (using DeepL API for European languages and Japanese; Google Cloud Translation for South/Southeast Asian languages and Swahili) to generate initial `messages/[locale].json` for all 14 non-English locales.

### Step 16 — Add CI translation completeness check

Create `scripts/check-translations.ts` — fails the build if any locale JSON is missing keys present in `en.json`. Wire into `package.json` scripts and GitHub Actions.

### Step 17 — Update sitemap

Create or update `app/sitemap.ts` to include all locale variants of every route (see Section 8).

### Step 18 — Verify TypeScript

```bash
bun typecheck
```

Resolve any type errors introduced by the `params: Promise<{ locale: string }>` pattern.

### Step 19 — Smoke test all 15 locales

Run `bun dev` and verify:

- `/en/`, `/zh/`, `/ar/`, `/ur/` load correctly
- RTL layout is applied for Arabic and Urdu
- Locale switcher navigates correctly and persists the cookie
- `bun build` succeeds

---

## 7. Translation Strategy

### Phase 1 — Machine Translation Bootstrap

Use automated translation to generate all 14 non-English locale files from `messages/en.json`.

**DeepL API** (preferred for): `de`, `fr`, `es`, `pt`, `ru`, `ja`, `id`
**Google Cloud Translation** (preferred for): `zh`, `hi`, `bn`, `ur`, `ar`, `sw`, `mr`

Script approach (`scripts/translate-messages.ts`):

1. Read `messages/en.json`
2. For each target locale, call the appropriate API
3. Write output to `messages/[locale].json`
4. Maintain a separate `messages/_review-status.json` tracking which keys have been human-reviewed per locale

### Phase 2 — Human Review Priority

Prioritize by expected traffic and SRS tool adoption:

| Priority | Locales                | Rationale                                   |
| -------- | ---------------------- | ------------------------------------------- |
| High     | `zh`, `ja`             | Large diaspora + highest Anki/SRS usage     |
| High     | `es`, `de`, `fr`, `pt` | Large, tech-literate audiences              |
| Medium   | `hi`, `id`, `ru`       | Large populations with growing SRS interest |
| Medium   | `ar`, `ur`             | RTL complexity requires layout review       |
| Lower    | `bn`, `sw`, `mr`       | Lower expected traffic initially            |

### Phase 3 — Community Contributions

- Add a `CONTRIBUTING.md` section explaining how to submit translation improvements.
- Use **Crowdin** (free tier for open-source) or **Weblate** (self-hostable) to allow non-developer translators to work via a web UI.
- Crowdin can open PRs automatically with updated `messages/[locale].json` when translators approve strings.

### Ongoing Maintenance

- When new strings are added to `messages/en.json`, run the machine translation script for the new keys only and mark them as unreviewed in `_review-status.json`.
- The CI check (Step 16) prevents shipping an incomplete locale.

---

## 8. SEO Considerations

### hreflang Tags

Every page must declare alternates for all 15 locales plus `x-default`. Add to `generateMetadata` in `app/[locale]/layout.tsx` or in each page's own `generateMetadata`:

```tsx
const baseUrl = "https://www.lianki.com";
const route = "/list"; // per-page path

const languages: Record<string, string> = {};
for (const l of routing.locales) {
  languages[l] = `${baseUrl}/${l}${route}`;
}
languages["x-default"] = `${baseUrl}/en${route}`;

return {
  alternates: {
    canonical: `${baseUrl}/${locale}${route}`,
    languages,
  },
};
```

### Per-Locale Metadata

Each locale's JSON should include a translated `meta.description`. Example `messages/zh.json`:

```json
{
  "meta": {
    "title": "练记",
    "description": "使用 FSRS 算法进行间隔重复学习"
  }
}
```

Translated descriptions improve click-through rates in non-English search results.

### XML Sitemap

Create `app/sitemap.ts`:

```ts
import { routing } from "@/i18n/routing";

export default function sitemap() {
  const baseUrl = "https://www.lianki.com";
  const routes = ["/", "/list", "/add-note", "/profile"];

  return routing.locales.flatMap((locale) =>
    routes.map((route) => ({
      url: `${baseUrl}/${locale}${route}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: route === "/" ? 1.0 : 0.8,
    })),
  );
}
```

### `lang` and `dir` Attributes

The `app/[locale]/layout.tsx` sets `<html lang={lang} dir={dir}>` — this is the primary on-page signal for search engines to classify language. Verify it is correct for every locale before launch.

---

## 9. Locale Detection Priority

The middleware resolves locale using this waterfall:

```
1. URL prefix         /zh/list  → locale = "zh"
2. NEXT_LOCALE cookie NEXT_LOCALE=zh
3. Accept-Language    Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
4. Default            en
```

Steps 1, 3, and 4 are handled automatically by next-intl's `createMiddleware`.

Step 2 (stored user preference) is added to the middleware manually — when the user visits `/` with no locale prefix, redirect to their stored locale before next-intl's `Accept-Language` negotiation runs.

### Locale Switcher Persistence

When the user selects a locale via the UI:

```ts
document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;
router.push(`/${newLocale}${currentPath}`);
```

### Why This Order

- **URL prefix first** — The URL is explicit, bookmarkable, shareable, and the only SEO-relevant signal. It always wins.
- **Cookie second** — A returning user's explicit choice should not be overridden by browser settings.
- **`Accept-Language` third** — A reasonable first-visit default, but less reliable than an explicit choice.
- **English default** — English is the source language with the most complete and highest-quality translations.

---

## 10. Appendix

### Existing `middleware.ts`

The current `middleware.ts` handles only blog-level redirects (`/blog → /en/blog`) for two locale codes (`en`, `cn`). It will be **replaced entirely** by the next-intl middleware in Step 5. The blog redirect behavior must be preserved in the new file.

### `cn` → `zh` Migration

The existing middleware uses `cn` as the Chinese locale code (non-standard). ISO 639-1 / BCP 47 standard is `zh` (Simplified: `zh-Hans`). The new routing config uses `zh`. Add a permanent redirect from `/cn/*` to `/zh/*` in the new middleware or in `next.config.mjs` redirects to preserve any existing links or bookmarks.

```js
// next.config.mjs redirects (add if needed)
redirects: async () => [
  {
    source: "/cn/:path*",
    destination: "/zh/:path*",
    permanent: true,
  },
],
```

### FSRS Rating Labels

The FSRS review page uses four rating labels: `Again`, `Hard`, `Good`, `Easy`. These are standard SRS terminology. Consider whether to translate them or keep them in English for consistency with the wider SRS community (Anki uses the same terms). If translated, add them under a `"fsrs"` namespace in the message files.

### Blog Content

Blog posts are markdown files resolved by locale — this is a separate content translation pipeline distinct from the UI strings described in this plan. The `messages/` JSON approach covers UI strings only. Blog posts remain locale-specific markdown files.
