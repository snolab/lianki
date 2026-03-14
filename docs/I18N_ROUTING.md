# I18n Routing with Locale URL Prefixes

All pages in Lianki now use locale-specific URL slugs for proper internationalization.

## URL Structure

- **English**: `/en/*` (e.g., `/en/list`, `/en/membership`, `/en/blog`)
- **Chinese**: `/zh/*` (e.g., `/zh/list`, `/zh/membership`, `/zh/blog`)
- **Japanese**: `/ja/*` (e.g., `/ja/list`, `/ja/membership`, `/ja/blog`)
- **Korean**: `/ko/*` (e.g., `/ko/list`, `/ko/membership`, `/ko/blog`)

## Configuration

See `intlayer.config.ts`:

```typescript
{
  routing: {
    mode: "prefix-all", // All locales get URL prefix, including default
  }
}
```

## Automatic Redirects

The intlayer middleware automatically redirects non-localized URLs to the user's detected locale:

- `/` → `/en/` (or user's detected locale)
- `/list` → `/en/list`
- `/membership` → `/zh/membership` (if user's locale is Chinese)

Locale detection is based on:

1. Existing locale cookie
2. Accept-Language header from browser
3. Default locale (en) as fallback

## For Developers

### Client Components - Locale-Aware Links

Use the `LocaleLink` component for automatic locale prefixing:

```tsx
import { LocaleLink } from "@/lib/locale-link";

export default function MyComponent() {
  return (
    <div>
      <LocaleLink href="/profile">Profile</LocaleLink>
      {/* Renders as /en/profile, /zh/profile, etc. */}
    </div>
  );
}
```

### Client Components - Programmatic Navigation

Use the `useLocalePath` hook with `useRouter`:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useLocalePath } from "@/lib/locale-link";

export default function MyComponent() {
  const router = useRouter();
  const localePath = useLocalePath();

  const handleClick = () => {
    router.push(localePath("/profile"));
    // Navigates to /en/profile, /zh/profile, etc.
  };

  return <button onClick={handleClick}>Go to Profile</button>;
}
```

### Server Components - Redirects

Use the `localeRedirect` helper for server-side redirects:

```tsx
import { localeRedirect } from "@/lib/locale-redirect";

export default async function MyPage() {
  const isAuthenticated = await checkAuth();

  if (!isAuthenticated) {
    localeRedirect("/sign-in");
    // Redirects to /en/sign-in, /zh/sign-in, etc.
  }

  return <div>Protected content</div>;
}
```

### Accessing Current Locale

**Client Components:**

```tsx
"use client";
import { useLocale } from "next-intlayer";

export default function MyComponent() {
  const locale = useLocale();
  console.log(locale.locale); // "en", "zh", "ja", or "ko"

  return <div>Current locale: {locale.locale}</div>;
}
```

**Server Components:**

```tsx
import { getLocale } from "next-intlayer/server";

export default async function MyPage() {
  const locale = await getLocale();
  console.log(locale); // "en", "zh", "ja", or "ko"

  return <div>Current locale: {locale}</div>;
}
```

## Special Routes (No Locale Prefix)

The following routes don't get locale prefixes:

- API routes: `/api/*`
- Auth routes: `/auth/*`
- Special redirects: `/next` (redirects to `/api/fsrs/next`)
- Static files: `/_next/*`, `/favicon.ico`, `/*.user.js`

## Blog Routes

Blog pages already had locale-based routing using `[locale]` dynamic segments:

- `/en/blog` - English blog index
- `/zh/blog/my-post` - Chinese blog post
- `/ja/blog` - Japanese blog index

These routes work seamlessly with the new system.

## Language Switcher

The language switcher must use `useRouter` and `usePathname` to navigate to the new locale URL:

```tsx
"use client";
import { useLocale } from "next-intlayer";
import { usePathname, useRouter } from "next/navigation";
import { BLOG_LOCALES } from "@/lib/constants";

export function LanguageSwitcher() {
  const { locale: currentLocale } = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  const switchLocale = (newLocale: string) => {
    // Replace current locale in pathname with new locale
    const newPath = pathname.replace(/^\/(en|zh|ja|ko)/, `/${newLocale}`);
    router.push(newPath);
  };

  return (
    <select value={currentLocale} onChange={(e) => switchLocale(e.target.value)}>
      {BLOG_LOCALES.map((l) => (
        <option key={l} value={l}>
          {l.toUpperCase()}
        </option>
      ))}
    </select>
  );
}
```

**Important:** Do NOT use `setLocale()` from `useLocale()` as it only changes the locale state without navigating to the new URL. You must use `router.push()` to navigate to the URL with the new locale prefix.

## Testing

To test different locales:

1. Visit `/zh/list` directly for Chinese
2. Visit `/ja/membership` directly for Japanese
3. Visit `/ko/profile` directly for Korean
4. Or change browser language and visit `/` - you'll be redirected to the appropriate locale

## Migration Notes

### Breaking Changes

- All routes now require locale prefix
- Old bookmarks without locale prefix will be automatically redirected
- Internal links should be updated to use `LocaleLink` or `useLocalePath` for better performance

### Gradual Migration

The middleware handles automatic redirection, so existing links without locale prefixes will still work (they'll just redirect once). For best performance, update links gradually:

1. High-traffic pages first (landing, list, membership)
2. Navigation components (header, footer, menus)
3. Individual page links

## SEO and Hreflang Tags

All pages include proper hreflang tags for SEO, following Google's best practices for multilingual websites.

### How Hreflang Works

Each page automatically generates hreflang links in the `<head>` that tell search engines about language variations:

```html
<link rel="canonical" href="https://www.lianki.com/en/list" />
<link rel="alternate" hreflang="en" href="https://www.lianki.com/en/list" />
<link rel="alternate" hreflang="zh-Hans" href="https://www.lianki.com/zh/list" />
<link rel="alternate" hreflang="ja" href="https://www.lianki.com/ja/list" />
<link rel="alternate" hreflang="ko" href="https://www.lianki.com/ko/list" />
<link rel="alternate" hreflang="x-default" href="https://www.lianki.com/en/list" />
```

### Adding Hreflang to New Pages

Use the `generateHreflangMetadata` helper function in your page's `generateMetadata`:

```tsx
import type { Metadata } from "next";
import { generateHreflangMetadata } from "@/lib/hreflang";
import { getLocale } from "next-intlayer/server";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  return {
    title: "My Page Title",
    description: "My page description",
    ...generateHreflangMetadata(locale, "/my-page"),
  };
}
```

For dynamic pages with slugs:

```tsx
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  return {
    title: `${slug} - Lianki`,
    ...generateHreflangMetadata(locale, `/blog/${slug}`),
  };
}
```

## Learn More

- [Google SEO: Multi-regional and multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
- [Intlayer Documentation](https://intlayer.org/doc/concept/routing)
- [Next.js i18n Routing](https://nextjs.org/docs/app/building-your-application/routing/internationalization)
