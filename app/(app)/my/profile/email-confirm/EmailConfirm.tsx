"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useIntlayer } from "next-intlayer";

type State = "idle" | "busy" | "done" | "invalid" | "unavailable" | "failed";

export function EmailConfirm() {
  const t = useIntlayer("profile-edit");
  const router = useRouter();
  const [state, setState] = useState<State>("idle");

  async function confirm() {
    setState("busy");
    try {
      const r = await fetch("/api/profile/email/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: location.hash.slice(1) }),
      });
      if (r.ok) {
        history.replaceState(null, "", location.pathname); // the token leaves the address bar
        setState("done");
        router.refresh(); // signed in here: the nav's address changes
      } else if (r.status === 400) setState("invalid");
      else if (r.status === 409) setState("unavailable");
      else setState("failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <h1 className="mb-4 text-2xl font-bold">{t.confirmTitle}</h1>
      {state === "done" ? (
        <p role="status" data-testid="email-confirm-done">
          {t.confirmDone}
        </p>
      ) : (
        <>
          <p className="mb-4">{t.confirmIntro}</p>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={state === "busy"}
            className="min-h-11 rounded-full bg-[oklch(0.55_0.198_22.3)] px-5 text-[oklch(0.98_0_0)] disabled:opacity-50"
            data-testid="email-confirm"
          >
            {t.confirmButton}
          </button>
          {state === "invalid" && (
            <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
              {t.confirmInvalid}
            </p>
          )}
          {state === "unavailable" && (
            <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
              {t.confirmUnavailable}
            </p>
          )}
          {state === "failed" && (
            <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">
              {t.saveFailed}
            </p>
          )}
        </>
      )}
    </div>
  );
}
