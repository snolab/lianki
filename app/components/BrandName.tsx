import { BRAND_DOMAIN, cjkWordmark } from "@/lib/brand";

/**
 * The name beside the seal in the top bar: "Lianki.com" where there is room,
 * so the address is the brand. CJK locales show 鏈記 (lianki.com) — the
 * domain in small type, on every width (lib/brand.ts). Another localized name
 * (लियांकी, Лианки…) stays, with the domain after it where there is room; on
 * a narrow screen, only the name.
 */
export function BrandName({ appName, locale }: { appName: string; locale?: string }) {
  const cjk = cjkWordmark(locale);
  if (cjk)
    return (
      <span className="font-brush font-normal tracking-wider whitespace-nowrap" data-brand={cjk}>
        {cjk}
        <span className="ms-1 text-sm tracking-normal opacity-60" data-brand-domain>
          ({BRAND_DOMAIN})
        </span>
      </span>
    );
  const latin = appName === "Lianki";
  return (
    <span className="font-brush font-normal tracking-wider whitespace-nowrap" data-brand={appName}>
      {appName}
      {latin ? (
        <span className="hidden sm:inline" data-brand-domain>
          .com
        </span>
      ) : (
        <span className="hidden sm:inline ms-2 text-sm opacity-60" data-brand-domain>
          Lianki.com
        </span>
      )}
    </span>
  );
}
