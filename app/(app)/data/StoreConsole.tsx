"use client";

import type { StoreStats } from "@/app/lib/notesAdmin";
import { Icon, type IconName } from "@/app/components/icons";
import type { LocalSnapshot, UserscriptStatus } from "@/app/lib/localStore";
import { useIntlayer } from "next-intlayer";

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
  /** Holds `dev`: the diagnostics (userscript version, its count here, the backend). */
  dev?: boolean;
};

function StoreCard({
  icon,
  name,
  where,
  children,
}: {
  icon: IconName;
  name: string;
  where: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 min-w-[10rem] rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon name={icon} className="text-lg" />
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
  dev = false,
}: Props) {
  const s = useIntlayer("data-page").store;
  const localDirty = local?.cards.filter((c) => c.synced === false).length ?? 0;

  return (
    <section aria-labelledby="stores-heading">
      <h2 id="stores-heading" className="text-xl font-semibold mb-3">
        {heading}
      </h2>

      <div className="flex flex-wrap gap-4">
        {/* Only where the userscript has run on this site (owner, 2026-11-14): no
            card, and no "not run here yet" hint, otherwise. */}
        {script && (
          <StoreCard icon="floppyDisk" name={s.scriptName.value} where={s.scriptWhere.value}>
            <Stat label={s.cards.value} value={script.cardCount} />
            <Stat label={s.due.value} value={script.dueCount} />
            {/* Diagnostics, for developers only (English). */}
            {dev && <Stat label="Version" value={`v${script.version}`} />}
            <Stat label={s.lastSync.value} value={new Date(script.lastSync).toLocaleTimeString()} />
          </StoreCard>
        )}

        <StoreCard icon="folderSimple" name={s.localName.value} where={s.localWhere.value}>
          <Stat label={s.cards.value} value={local ? local.cards.length : "…"} />
          <Stat label={s.unsynced.value} value={local ? localDirty : "…"} />
          {dev && <Stat label="Script count" value={local?.gmCount ?? "—"} />}
        </StoreCard>

        <StoreCard
          icon="cloud"
          name={s.cloudName.value}
          where={isLoggedIn ? s.cloudWhere.value : s.signedOut.value}
        >
          {isLoggedIn ? (
            <>
              <Stat label={s.cards.value} value={cloud ? cloud.notes : "…"} />
              <Stat label={s.due.value} value={cloud ? cloud.due : "…"} />
              <Stat label={s.goals.value} value={cloud ? cloud.goals : "…"} />
              {dev && cloud && <Stat label="Backend" value={cloud.backend} />}
            </>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">{s.signInSync}</p>
          )}
        </StoreCard>
      </div>

      {/* Local → Cloud: the direction the userscript never covers. Nothing to
          copy (0 cards here), no button (owner, 2026-11-14: "数据是零的话，甚至都不需要显示"). */}
      <div className="mt-4 flex items-center gap-3 flex-wrap">
        {(pendingPush > 0 || pushing) && (
          <button
            type="button"
            onClick={onPush}
            disabled={!isLoggedIn || pushing}
            title={isLoggedIn ? undefined : s.pushSignIn.value}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pushing ? s.pushing : `${pushLabel} (${pendingPush})`}
          </button>
        )}
        {pushResult && (
          <span className="text-sm text-gray-600 dark:text-gray-400">{pushResult}</span>
        )}
      </div>
    </section>
  );
}
