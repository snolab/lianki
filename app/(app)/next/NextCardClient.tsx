"use client";

import { useEffect, useState } from "react";
import { readLocalStore } from "@/app/lib/localStore";
import { pickNextDue } from "@/lib/next-card";

/**
 * "Next card", for whichever store actually holds your deck.
 *
 * This used to redirect straight to `/api/fsrs/next`, which reads the cloud and
 * nothing else. Signed out, that is a 401; signed in with cards that never made
 * it to the cloud, it reports an empty deck while the userscript is still
 * serving those cards on every page. Either way the button did nothing.
 *
 * Signed in with a cloud card due, it goes to /review, the in-site review page
 * (owner, 2026-11-01). The bare HTML flow it used to hand over to
 * (/api/fsrs/next → /api/fsrs/repeat) is unchanged and still reachable,
 * linked from /review's footer. When the cloud has nothing due (or there is
 * no cloud, because you are a guest), the local mirror gets a turn.
 *
 * That mirror is the userscript's own store. `syncToSiteDB()` writes GM storage
 * into `lianki-keyval` on every visit here, so reading it reaches the cards the
 * userscript would serve — the "Script" store that the page cannot otherwise
 * see. Reviewing them is the userscript's job, so we simply go to the page and
 * let it open its dialog there.
 */

type Phase = { state: "looking" } | { state: "empty" } | { state: "going"; url: string };

export default function NextCardClient({
  isLoggedIn,
  listHref,
}: {
  isLoggedIn: boolean;
  listHref: string;
}) {
  const [phase, setPhase] = useState<Phase>({ state: "looking" });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Cloud first: if it has something due, /review takes over.
      if (isLoggedIn) {
        try {
          const res = await fetch("/api/fsrs/next-url");
          if (res.ok) {
            const { url } = (await res.json()) as { url: string | null };
            if (url) {
              location.replace("/review");
              return;
            }
          }
        } catch {
          // Offline or signed out mid-session — fall through to the local deck,
          // which is exactly the case this page now covers.
        }
      }

      if (cancelled) return;
      try {
        const { cards } = await readLocalStore();
        const next = pickNextDue(cards);
        if (cancelled) return;
        if (next) {
          setPhase({ state: "going", url: next.url });
          location.href = next.url;
          return;
        }
      } catch {
        // An unreadable mirror is not an empty deck, but there is nothing else
        // to try, and "nothing due" is the honest thing to show.
      }
      if (!cancelled) setPhase({ state: "empty" });
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoggedIn]);

  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center">
      {phase.state === "looking" && (
        <p className="text-lg text-gray-600 dark:text-gray-300">Finding your next card…</p>
      )}

      {phase.state === "going" && (
        <p className="text-lg text-gray-600 dark:text-gray-300">
          Opening{" "}
          <a href={phase.url} className="break-all text-blue-600 underline dark:text-blue-400">
            {phase.url}
          </a>
        </p>
      )}

      {phase.state === "empty" && (
        <>
          <p className="mb-2 text-2xl font-semibold">Nothing due right now</p>
          <p className="mb-6 text-gray-600 dark:text-gray-300">
            {isLoggedIn
              ? "Every card in your cloud and local decks is scheduled for later."
              : "Nothing is due in this browser's deck. Sign in to review cards saved on other devices."}
          </p>
          <a
            href={listHref}
            className="rounded-lg bg-blue-600 px-6 py-3 font-medium text-white hover:bg-blue-700"
          >
            Back to your cards
          </a>
        </>
      )}
    </div>
  );
}
