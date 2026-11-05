import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { connectionsOn } from "@/lib/connections/gate";
import { getConnection, googleConfig } from "@/lib/connections/google";
import { listGdocImports } from "@/lib/connections/gdoc-imports";
import ConnectionsClient, { type ConnectionsLabels } from "./ConnectionsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("connections-page", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

const RESULTS = new Set(["connected", "denied", "failed", "bad-state", "not-configured"]);

/**
 * /connections (docs/connections.md): the signed-in user's Google Drive
 * connection — status, account, granted access, connect and disconnect.
 * Dark behind `connections.google` (the owner sees it while it is off).
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await appLocale();
  const c = getIntlayer("connections-page", locale);
  const labels = Object.fromEntries(
    Object.entries(c).map(([k, v]) => [k, String(v)]),
  ) as unknown as ConnectionsLabels;
  const user = await authUserOrNull();
  if (!user)
    return (
      <div className="max-w-xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold mb-4">{labels.title}</h1>
        <a href="/sign-in" className="text-[oklch(0.55_0.18_255)] underline">
          {labels.signIn}
        </a>
      </div>
    );
  if (dbBackend() !== "d1" || !connectionsOn(await readFlags(), isOwner(user.email))) notFound();

  const db = getD1() as unknown as D1Like;
  const [conn, imports] = await Promise.all([
    getConnection(db, user.id),
    listGdocImports(db, user.id),
  ]);
  const raw = (await searchParams).google;
  const result = typeof raw === "string" && RESULTS.has(raw) ? raw : null;
  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold mb-2">{labels.title}</h1>
      <p className="text-sm text-[oklch(0.5_0.02_260)] dark:text-[oklch(0.72_0.02_260)] mb-6">
        {labels.intro}
      </p>
      <ConnectionsClient
        labels={labels}
        configured={!!googleConfig(process.env)}
        initial={conn ? { email: conn.email, scopes: conn.scopes, status: conn.status } : null}
        result={result}
        imports={imports}
        locale={locale}
      />
    </div>
  );
}
