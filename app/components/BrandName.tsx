/**
 * The name beside the seal in the top bar: "Lianki.com" where there is room,
 * so the address is the brand. A localized name (炼記, 련키…) stays, with the
 * domain in small type after it; on a narrow screen, only the name.
 */
export function BrandName({ appName }: { appName: string }) {
  const latin = appName === "Lianki";
  return (
    <span className="font-brush font-normal tracking-wider whitespace-nowrap">
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
