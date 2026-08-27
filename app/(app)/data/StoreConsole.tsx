"use client";

import type { StoreStats } from "@/app/lib/notesAdmin";
import type { LocalSnapshot, UserscriptStatus } from "@/app/lib/localStore";

type Props = {
  heading: string;
  script: UserscriptStatus | null;
  local: LocalSnapshot | null;
  cloud: StoreStats | null;
  isLoggedIn: boolean;
  /** Urls present in Local but missing from Cloud — the push candidates. */
  pendingPush: number;
  pushing: boolean;
  pushResult: string | null;
  pushLabel: string;
  onPush: () => void;
  scriptHint: string;
};

function StoreCard({
  icon,
  name,
  where,
  children,
}: {
  icon: string;
  name: string;
  where: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 min-w-[10rem] rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-baseline gap-2 mb-1">
        <span aria-hidden className="text-lg leading-none">
          {icon}
        </span>
        <h3 className="font-semibold">{name}</h3>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{where}</p>
      <dl className="space-y-1 text-sm">{children}</dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

export default function StoreConsole({
  heading,
  script,
  local,
  cloud,
  isLoggedIn,
  pendingPush,
  pushing,
  pushResult,
  pushLabel,
  onPush,
  scriptHint,
}: Props) {
  const localDirty = local?.cards.filter((c) => c.synced === false).length ?? 0;

  return (
    <section aria-labelledby="stores-heading">
      <h2 id="stores-heading" className="text-xl font-semibold mb-3">
        {heading}
      </h2>

      <div className="flex flex-wrap gap-4">
        <StoreCard icon="💾" name="Script" where="Userscript (GM storage)">
          {script ? (
            <>
              <Stat label="Cards" value={script.cardCount} />
              <Stat label="Due" value={script.dueCount} />
              <Stat label="Version" value={`v${script.version}`} />
              <Stat label="Last sync" value={new Date(script.lastSync).toLocaleTimeString()} />
            </>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">{scriptHint}</p>
          )}
        </StoreCard>

        <StoreCard icon="🗂️" name="Local" where="This browser (IndexedDB)">
          <Stat label="Cards" value={local ? local.cards.length : "…"} />
          <Stat label="Unsynced" value={local ? localDirty : "…"} />
          <Stat label="Script count" value={local?.gmCount ?? "—"} />
        </StoreCard>

        <StoreCard
          icon="☁️"
          name="Cloud"
          where={cloud ? cloud.backend.toUpperCase() : "Signed out"}
        >
          {isLoggedIn ? (
            <>
              <Stat label="Cards" value={cloud ? cloud.notes : "…"} />
              <Stat label="Due" value={cloud ? cloud.due : "…"} />
              <Stat label="Roadmap goals" value={cloud ? cloud.goals : "…"} />
            </>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Sign in to sync your cards across devices.
            </p>
          )}
        </StoreCard>
      </div>

      {/* Local → Cloud: the direction the userscript never covers. */}
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onPush}
          disabled={!isLoggedIn || pushing || pendingPush === 0}
          title={isLoggedIn ? undefined : "Sign in to push your local cards to the cloud"}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pushing ? "Pushing…" : `${pushLabel} (${pendingPush})`}
        </button>
        {pushResult && (
          <span className="text-sm text-gray-600 dark:text-gray-400">{pushResult}</span>
        )}
      </div>
    </section>
  );
}
