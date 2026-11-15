import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { SCOPE_IDS, type ScopeId } from "@/lib/api-tokens";
import TokenScopeClient from "./TokenScopeClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const c = getIntlayer("api-tokens", await appLocale()) as unknown as Record<string, unknown>;
  return {
    title: String(c.scopeRequestTitle),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/** A public token id is not its bearer secret. Opening this page never adds a scope. */
export default async function TokenScopePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const id =
    typeof params.token === "string" && /^[0-9a-f]{64}$/.test(params.token) ? params.token : null;
  const scope =
    typeof params.scope === "string" && (SCOPE_IDS as readonly string[]).includes(params.scope)
      ? (params.scope as ScopeId)
      : null;
  return <TokenScopeClient key={`${id}:${scope}`} id={id} scope={scope} />;
}
