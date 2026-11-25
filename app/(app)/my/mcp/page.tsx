import type { Metadata } from "next";
import Link from "next/link";
import { getIntlayer } from "intlayer";
import { authUserOrNull, signInRedirect } from "@/app/signInEmail";
import { appLocale } from "@/lib/app-locale.server";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { MCP_REMOTE_URL } from "@/lib/agent-guide";
import TokenManager from "../preferences/TokenManager";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const t = getIntlayer("my-mcp", locale);
  return {
    title: t.title,
    description: t.intro,
    robots: { index: false, follow: false },
    ...generateAppHreflangMetadata(locale, "/my/mcp"),
  };
}

/** Account-scoped token management; opening this page never creates a credential. */
export default async function MyMcpPage() {
  if (!(await authUserOrNull())) return signInRedirect();
  const t = getIntlayer("my-mcp", await appLocale());
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="mb-2 text-3xl font-bold">{t.title}</h1>
      <p className="mb-4">{t.intro}</p>
      <code className="block break-all rounded border p-3">{MCP_REMOTE_URL}</code>
      <Link href="/mcp" className="mt-3 inline-block text-primary underline">
        {t.guide}
      </Link>
      <TokenManager />
    </main>
  );
}
