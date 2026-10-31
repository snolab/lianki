import { BRAND_DOMAIN, cjkWordmark } from "@/lib/brand";

/**
 * The name beside the seal in the top bar, on every width (lib/brand.ts):
 * 鏈記 (lianki.com) in CJK locales, the domain in small type; Lianki.com
 * everywhere else — the address is the brand. A localized `appName`
 * (Лианки, लियांकी…) shows as its tooltip.
 *
 * Built in, and the `header.brand` island (lib/islands/contract.ts): the
 * Header and the AppShell both render it through that island.
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
  return (
    <span
      className="font-brush font-normal tracking-wider whitespace-nowrap"
      data-brand="Lianki"
      title={appName === "Lianki" ? undefined : appName}
    >
      Lianki<span data-brand-domain>.com</span>
    </span>
  );
}
