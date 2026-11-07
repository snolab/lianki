"use client";

/**
 * /read/[id] on a box (docs/box-oauth.md, "Flags on a box"). The box's server
 * reads its own local D1 and has no session, so its pick is not the account's:
 * here the pick and the draft gate are made again from production's flags and
 * owner role for the bound account, which BoxApiBridge read from lianki.com
 * before the page rendered. Off a box this component is not used.
 */
import { useFlagView } from "@/app/components/BoxApiBridge";
import type { FlagValues } from "@/lib/flags";
import { draftAllowedFor, readerPick } from "@/lib/read/reader-access";
import { ReadViewClient } from "./ReadViewClient";
import { ReaderV2 } from "./ReaderV2";

export function ReaderChoice({
  id,
  isLoggedIn,
  streaming,
  dev,
  query,
  serverFlags,
  serverOwner,
}: {
  id: string;
  isLoggedIn: boolean;
  streaming: boolean;
  dev: boolean;
  query?: string | string[] | null;
  serverFlags: FlagValues | null;
  serverOwner: boolean;
}) {
  const { flags, owner } = useFlagView({ flags: serverFlags, owner: serverOwner });
  if (readerPick({ flags, owner, dev, query }) === "v2")
    return (
      <ReaderV2
        id={id}
        isLoggedIn={isLoggedIn}
        streaming={streaming}
        draftAllowed={draftAllowedFor(flags, owner)}
      />
    );
  return (
    <div className="flex flex-col">
      <div className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <ReadViewClient id={id} isLoggedIn={isLoggedIn} />
        </div>
      </div>
    </div>
  );
}
