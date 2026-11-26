import type { Metadata } from "next";
import Link from "next/link";
import { getIntlayer } from "intlayer";
import { appLocale } from "@/lib/app-locale.server";
import { generateAppHreflangMetadata } from "@/lib/hreflang";
import { AI_APPS, AI_APPS_FEEDBACK_PATH, AI_APPS_GUIDE_PATH, fillGuide } from "@/lib/ai-apps-guide";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await appLocale();
  const g = getIntlayer("ai-apps-guide", locale);
  return {
    title: String(g.title),
    description: String(g.metaDescription),
    ...generateAppHreflangMetadata(locale, AI_APPS_GUIDE_PATH),
  };
}

/**
 * The public guide to connecting ChatGPT, Claude or Gemini to the reader's own
 * Lianki account (docs/api-for-agents.md, "The public guide"). No session is
 * read: signed out, the "open" link goes to /my/mcp, which asks to sign in.
 * Text steps only, no screenshots (they would show someone's account). The
 * other apps' own steps, plans and limits are never restated, only linked
 * (lib/ai-apps-guide.ts): the page says only what Lianki needs.
 */
export default async function AiAppsGuidePage() {
  const locale = await appLocale();
  const g = getIntlayer("ai-apps-guide", locale);
  const tok = getIntlayer("api-tokens", locale);
  const mcp = getIntlayer("my-mcp", locale);
  const vars = {
    page: String(mcp.title),
    tokens: String(tok.heading),
    study: String(tok.scopeStudy),
    create: String(tok.create),
    copy: String(tok.copyMcp),
    revoke: String(tok.revoke),
  };
  const f = (text: unknown) => fillGuide(text, vars);

  const card =
    "rounded-2xl border border-gray-200 dark:border-gray-700 bg-[var(--background)] p-4 sm:p-5";
  const h2 = "text-xl font-semibold";
  const ol = "list-decimal ps-6 space-y-2 marker:font-semibold marker:text-primary";

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:py-8 flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl sm:text-3xl font-bold">{g.title}</h1>
        <p>{g.intro}</p>
        <p
          role="note"
          className="rounded-lg border-s-4 border-primary bg-gold-50 p-3 text-sm dark:bg-gold-950"
        >
          {g.introLimits}
        </p>
      </header>

      <section aria-labelledby="can" className={card}>
        <h2 id="can" className={h2}>
          {g.canHeading}
        </h2>
        <ul className="mt-3 list-disc ps-6 space-y-1">
          <li>{g.canDue}</li>
          <li>{g.canAdd}</li>
          <li>{g.canReview}</li>
          <li>{g.canChat}</li>
        </ul>
        <p className="mt-3 text-sm opacity-80">{g.canLimits}</p>
      </section>

      <nav aria-label={String(g.jump)} className="flex rounded-full border border-primary p-1">
        {AI_APPS.map((a) => (
          <a
            key={a.id}
            href={`#${a.id}`}
            className="flex-1 rounded-full px-3 py-2 text-center text-sm font-semibold text-primary hover:bg-primary hover:text-on-primary"
          >
            {a.name}
          </a>
        ))}
      </nav>

      <section aria-labelledby="lianki" className={card}>
        <h2 id="lianki" className={h2}>
          {g.liankiHeading}
        </h2>
        <ol className={`${ol} mt-3`}>
          <li>{f(g.liankiOpen)}</li>
          <li>{f(g.liankiName)}</li>
          <li>{f(g.liankiStudy)}</li>
          <li>{f(g.liankiCreate)}</li>
          <li>{f(g.liankiCopy)}</li>
        </ol>
        <Link
          href="/my/mcp"
          className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 font-semibold text-on-primary hover:opacity-90"
        >
          {f(g.openButton)}
        </Link>
        <p
          role="note"
          className="mt-4 rounded-lg border-s-4 border-primary bg-gold-50 p-3 text-sm dark:bg-gold-950"
        >
          {g.secret}
        </p>
      </section>

      <section aria-labelledby="apps" className="flex flex-col gap-4">
        <div>
          <h2 id="apps" className={h2}>
            {g.appsHeading}
          </h2>
          <p className="mt-1">{g.appsLead}</p>
        </div>
        {AI_APPS.map((a) => (
          <section
            key={a.id}
            id={a.id}
            aria-labelledby={`${a.id}-h`}
            className={`${card} scroll-mt-20 flex flex-col gap-2`}
          >
            <h3 id={`${a.id}-h`} className="text-lg font-semibold text-primary">
              {a.name}
            </h3>
            <a
              href={a.help}
              target="_blank"
              rel="noopener noreferrer"
              className="self-start font-medium text-primary underline"
            >
              {g.helpLink}
            </a>
            <p>{a.auth ? fillGuide(g.enterLink, { auth: a.auth }) : g.geminiEnter}</p>
            {a.at ? <p>{g.callAt}</p> : null}
          </section>
        ))}
        <a
          href={AI_APPS_FEEDBACK_PATH}
          data-testid="guide-feedback"
          className="self-start text-sm font-medium text-primary underline"
        >
          {g.stepsWrong}
        </a>
      </section>

      <section aria-labelledby="safety" className={card}>
        <h2 id="safety" className={h2}>
          {g.safetyHeading}
        </h2>
        <ul className="mt-3 list-disc ps-6 space-y-2">
          <li>{f(g.safeRevoke)}</li>
          <li>{g.safeExpire}</li>
          <li>{g.safeData}</li>
        </ul>
      </section>

      <section aria-labelledby="trouble" className={card}>
        <h2 id="trouble" className={h2}>
          {g.troubleHeading}
        </h2>
        <ul className="mt-3 list-disc ps-6 space-y-2">
          <li>{g.troubleRefused}</li>
          <li>{g.troubleAsk}</li>
        </ul>
      </section>

      <section aria-labelledby="other" className={card}>
        <h2 id="other" className={h2}>
          {g.otherHeading}
        </h2>
        <p className="mt-2">{f(g.otherBody)}</p>
      </section>
    </main>
  );
}
