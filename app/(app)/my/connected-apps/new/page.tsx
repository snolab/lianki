import type { Metadata } from "next";
import { getIntlayer } from "intlayer";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { appLocale } from "@/lib/app-locale.server";
import { SCOPES } from "@/lib/api-tokens";
import { SCOPE_TEXT } from "@/app/components/token-scope-text";
import { authorizeView } from "@/lib/mcp-oauth/handlers";
import { oauthDeps } from "@/lib/mcp-oauth/deps";
import { AUTHORIZE_PATH, originFor } from "@/lib/mcp-oauth/rules";
import { SIGN_IN_RETURN_PARAM } from "@/lib/dev-server-switch";

/**
 * The OAuth consent page for the remote MCP server (docs/mcp-oauth.md): an app
 * such as ChatGPT sends the user here to sign in with their Lianki account.
 * Opening it changes nothing; the form posts to /api/mcp-oauth/consent, which
 * checks everything again. 404 while mcp.oauth is off.
 */
export const dynamic = "force-dynamic";

type Strings = Record<string, unknown>;
const text = (c: Strings, k: string) => String(c[k] ?? "");

export async function generateMetadata(): Promise<Metadata> {
  const c = getIntlayer("connected-apps", await appLocale()) as unknown as Strings;
  return {
    title: `${text(c, "consentTitle")} - Lianki`,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

async function origin(): Promise<string> {
  return originFor((await headers()).get("host"));
}

export default async function ConnectAppPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") search.set(k, v);
  const view = await authorizeView(search, await origin(), AUTHORIZE_PATH, oauthDeps());
  if (view.kind === "not-found") notFound();
  if (view.kind === "redirect") redirect(view.to);
  if (view.kind === "sign-in")
    redirect(`/sign-in?${new URLSearchParams({ [SIGN_IN_RETURN_PARAM]: view.back })}`);

  const locale = await appLocale();
  const c = getIntlayer("connected-apps", locale) as unknown as Strings;
  const tok = getIntlayer("api-tokens", locale) as unknown as Strings;
  if (view.kind === "invalid")
    return (
      <main className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center gap-4 p-5">
        <h1 className="text-xl font-semibold">{text(c, "invalidTitle")}</h1>
        <p role="alert">{text(c, "invalidBody")}</p>
      </main>
    );

  const { client, request, host, email, fields, action } = view;
  return (
    <main
      className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center gap-5 p-5"
      data-testid="connect-app"
    >
      <h1 className="text-xl font-semibold">{text(c, "consentTitle")}</h1>
      <section className="space-y-2 rounded-lg border border-current/20 p-4">
        <p className="break-words text-lg">
          {text(c, "consentIntro")
            .split("{name}")
            .flatMap((part, i) =>
              i === 0
                ? [part]
                : [
                    <strong key={i} className="break-all" data-testid="connect-app-name">
                      {client.name}
                    </strong>,
                    part,
                  ],
            )}
        </p>
        <p className="text-sm opacity-80" data-testid="connect-app-host">
          {text(c, "consentSelfNamed").replaceAll("{host}", host)}
        </p>
        <p className="text-sm opacity-70">
          {text(c, "consentSignedInAs").replaceAll("{email}", email)}
        </p>
      </section>
      <form method="post" action={action} className="space-y-4">
        {fields.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">{text(c, "consentPermissions")}</legend>
          {SCOPES.filter(({ id }) => request.scopes.includes(id)).map(({ id }) => (
            <label key={id} className="flex items-start gap-2">
              <input type="checkbox" name="grant" value={id} defaultChecked className="mt-1" />
              <span>
                <span className="font-medium">{text(tok, SCOPE_TEXT[id].label)}</span>{" "}
                <code className="text-xs opacity-60">{id}</code>
                <span className="block text-xs opacity-70">{text(tok, SCOPE_TEXT[id].hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-sm opacity-70">{text(c, "consentNever")}</p>
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            name="decision"
            value="allow"
            data-testid="connect-app-allow"
            className="min-h-11 rounded bg-primary px-4 py-2 text-on-primary"
          >
            {text(c, "consentAllow")}
          </button>
          <button
            type="submit"
            name="decision"
            value="deny"
            data-testid="connect-app-deny"
            className="min-h-11 rounded border border-current/30 px-4 py-2"
          >
            {text(c, "consentDeny")}
          </button>
        </div>
      </form>
    </main>
  );
}
