/**
 * "This sign-in" on /profile, for every signed-in user: when this browser's
 * session began and when it expires. Only those two times — never the token,
 * the IP or the user agent (the raw dump is SessionDetailsCard, dev access
 * only). Times are in the request's time zone (Cloudflare places it from the
 * IP; JST for the owner at home), named in the text, UTC when unknown.
 */

export type SessionBasicsLabels = {
  heading: string;
  /** "Signed in since {date}" */
  since: string;
  /** "This session expires {date}" */
  expires: string;
  hint: string;
};

type Times = { createdAt: Date | string; expiresAt: Date | string };

/** A date and time people read, with its zone: "November 9, 2026, 6:15 PM GMT+9 (en) — 2026年11月9日 18:15 JST (ja)". */
export function sessionWhen(d: Date | string, locale: string, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  const at = new Date(d);
  try {
    return at.toLocaleString(locale, { ...opts, timeZone: timeZone ?? "UTC" });
  } catch {
    return at.toLocaleString(locale, { ...opts, timeZone: "UTC" }); // not an IANA zone
  }
}

export function SessionBasicsCard({
  session,
  locale,
  timeZone,
  labels,
}: {
  session: Times | null | undefined;
  locale: string;
  timeZone?: string;
  labels: SessionBasicsLabels;
}) {
  if (!session) return null;
  const when = (d: Date | string) => sessionWhen(d, locale, timeZone);
  return (
    <section
      data-testid="session-basics"
      className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-6"
    >
      <h2 className="text-2xl font-semibold mb-3">{labels.heading}</h2>
      <p className="text-sm">{labels.since.replace("{date}", when(session.createdAt))}</p>
      <p className="text-sm">{labels.expires.replace("{date}", when(session.expiresAt))}</p>
      <p className="text-xs mt-2 text-gray-600 dark:text-gray-400">{labels.hint}</p>
    </section>
  );
}
