// The viewer's country for the /books admission rule (lib/books/terms.ts):
// Cloudflare's request.cf.country, else the CF-IPCountry header; unknown
// (dev, no geolocation, "XX", Tor) → null, which the rule treats as the
// conservative default term. Server only.

import { cfRequestProps } from "@/lib/d1";
import { normaliseCountry } from "./terms";

export function viewerCountry(headers?: Headers | null): string | null {
  return (
    normaliseCountry(cfRequestProps()?.country) ?? normaliseCountry(headers?.get("cf-ipcountry"))
  );
}

/** The calendar year the rule is judged in (terms end on 31 December, UTC). */
export function ruleYear(now = new Date()): number {
  return now.getUTCFullYear();
}
