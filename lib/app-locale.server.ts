import { headers } from "next/headers";
import { LOCALE_HEADER, resolveLocale } from "@/lib/app-locale";

export async function appLocale(): Promise<string> {
  return resolveLocale((await headers()).get(LOCALE_HEADER));
}
