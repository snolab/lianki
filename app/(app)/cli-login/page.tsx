import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { parseLoginParams, startRequest, tokenName } from "@/lib/cli-login";
import { dbBackend, getD1 } from "@/lib/d1";
import type { D1Like } from "@/lib/d1/types";
import CliLoginClient, { type CliLoginLabels } from "./CliLoginClient";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { title } = getIntlayer("cli-login-page", await appLocale());
  return { title: String(title), robots: { index: false, follow: false } };
}

/**
 * The browser half of `lianki auth login` (lib/cli-login.ts). Every parameter
 * is checked before anything is shown; a bad one gets an error and never a
 * redirect. A signed-in user sees what Approve creates, and the page starts a
 * pending request whose random id the Approve button sends back.
 */
export default async function CliLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const c = getIntlayer("cli-login-page", await appLocale());
  const labels = Object.fromEntries(
    Object.entries(c).map(([k, v]) => [k, String(v)]),
  ) as unknown as CliLoginLabels;
  const box = (body: React.ReactNode) => (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-5 p-4">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-bold">{labels.title}</h1>
        {body}
      </div>
    </div>
  );

  const parsed = parseLoginParams(await searchParams);
  if (!parsed.ok)
    return box(
      <p role="alert" className="text-red-500 text-sm">
        {labels.invalid}
      </p>,
    );
  const user = await authUserOrNull();
  if (!user)
    return box(
      <>
        <p className="text-sm">{labels.signInFirst}</p>
        <a
          href="/sign-in"
          target="_blank"
          rel="noopener"
          className="inline-block px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
        >
          {labels.signIn}
        </a>
      </>,
    );
  if (dbBackend() !== "d1")
    return box(
      <p role="alert" className="text-red-500 text-sm">
        {labels.failed}
      </p>,
    );

  const { params } = parsed;
  const requestId = await startRequest(
    getD1() as unknown as D1Like,
    { userId: user.id, email: user.email },
    params,
  );
  return box(
    <CliLoginClient
      labels={labels}
      requestId={requestId}
      state={params.state}
      redirectUri={params.redirectUri}
      name={tokenName(params.host)}
      email={user.email}
    />,
  );
}
