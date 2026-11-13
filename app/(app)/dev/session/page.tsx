import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { authUserOrNull } from "@/app/signInEmail";
import { isDev } from "@/lib/permissions";
import { SessionDetailsCard } from "./SessionDetailsCard";
import { devPageText, devPageMetadata } from "../dev-page-title";

// Dev access only, like every /dev page: anyone else gets a plain 404.
export const dynamic = "force-dynamic";

export const generateMetadata = devPageMetadata("session");

/** The viewer's own sign-in session, raw — moved off /my/profile, which is user UI. */
export default async function DevSessionPage() {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) notFound();
  const session = await auth.api.getSession({ headers: await headers() });
  const heading = await devPageText("session");
  return (
    <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <h1 lang={heading.lang} className="font-brush text-4xl">
        {heading.text}
      </h1>
      <SessionDetailsCard viewerEmail={user?.email} session={session} />
    </main>
  );
}
