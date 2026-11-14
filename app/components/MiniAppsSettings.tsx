"use client";

// Preferences → Mini apps (docs/mini-apps.md, "Permissions"): each of the
// account's apps and what the user answered for it; Remove forgets one
// answer, so the app asks again. Shown only while `mini-apps` is on.

import { useEffect, useState } from "react";
import { useIntlayer } from "next-intlayer";
import { CAPABILITIES, isCapability } from "@/lib/mini-apps/capabilities";
import type { Grants } from "@/lib/mini-apps/grants";

type App = { slug: string; name: string; icon: string; version: string; grants: Grants };

export function MiniAppsSettings() {
  const c = useIntlayer("mini-app");
  const [apps, setApps] = useState<App[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/my/mini-apps")
      .then((r) => (r.ok ? r.json() : { apps: [] }))
      .then((b: { apps?: App[] }) => live && setApps(b.apps ?? []))
      .catch(() => live && setApps([]));
    return () => {
      live = false;
    };
  }, []);

  async function revoke(slug: string, permission: string) {
    const r = await fetch(`/api/my/mini-apps/${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "revoke", permission }),
    }).catch(() => null);
    if (!r?.ok) return;
    const { grants } = (await r.json()) as { grants: Grants };
    setApps((all) => all?.map((a) => (a.slug === slug ? { ...a, grants } : a)) ?? null);
  }

  if (!apps?.length) return null;
  return (
    <section
      id="mini-apps"
      className="mb-10 max-w-xl scroll-mt-6"
      data-section="mini-apps"
      data-testid="mini-apps-settings"
    >
      <h2 className="mb-3 text-2xl font-semibold">{c.prefsHeading}</h2>
      <p className="mb-4 text-sm opacity-75">{c.prefsIntro}</p>
      <ul className="flex flex-col gap-4">
        {apps.map((a) => {
          const rows = Object.entries(a.grants).filter(([p, d]) => isCapability(p) && d !== "once");
          return (
            <li key={a.slug} className="rounded-xl border border-[oklch(0.5_0.02_70/0.25)] p-3">
              <div className="flex items-center gap-2">
                <span aria-hidden className="text-xl">
                  {a.icon}
                </span>
                <span className="flex-1 font-medium">{a.name}</span>
                <a
                  className="min-h-9 px-2 leading-9 underline-offset-4 hover:underline"
                  href={`/m/${a.slug}`}
                >
                  {c.prefsOpen}
                </a>
              </div>
              {rows.length === 0 ? (
                <p className="mt-2 text-sm opacity-70">{c.prefsNone}</p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1">
                  {rows.map(([p, d]) => (
                    <li key={p} className="flex min-h-11 items-center gap-2 text-sm">
                      <span className="flex-1">
                        {c[CAPABILITIES[p as keyof typeof CAPABILITIES].label]}
                      </span>
                      <span className={d === "allow" ? "font-semibold" : "opacity-70"}>
                        {d === "allow" ? c.prefsAllowed : c.prefsDenied}
                      </span>
                      <button
                        type="button"
                        className="min-h-9 rounded-lg border border-[oklch(0.5_0.02_70/0.35)] px-3"
                        onClick={() => void revoke(a.slug, p)}
                      >
                        {c.prefsRevoke}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
