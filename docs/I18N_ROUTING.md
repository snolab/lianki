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
- Static files: `/_next/*`, `/favicon.ico`, `/*.user.js`

## Blog Routes

Blog pages already had locale-based routing using `[locale]` dynamic segments:
- `/en/blog` - English blog index
- `/zh/blog/my-post` - Chinese blog post
- `/ja/blog` - Japanese blog index

These routes work seamlessly with the new system.

## Language Switcher

To implement a language switcher:

```tsx
"use client";
import { useLocale } from "next-intlayer";
import { usePathname, useRouter } from "next/navigation";
import { BLOG_LOCALES } from "@/lib/constants";

export function LanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  const switchLocale = (newLocale: string) => {
    // Replace current locale in pathname
    const newPath = pathname.replace(/^\/(en|zh|ja|ko)/, `/${newLocale}`);
    router.push(newPath);
  };

  return (
    <select value={locale.locale} onChange={(e) => switchLocale(e.target.value)}>
      {BLOG_LOCALES.map((l) => (
        <option key={l} value={l}>
          {l.toUpperCase()}
        </option>
      ))}
    </select>
  );
}
```

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

## Learn More

- [Intlayer Documentation](https://intlayer.org/doc/concept/routing)
- [Next.js i18n Routing](https://nextjs.org/docs/app/building-your-application/routing/internationalization)
