"use client";

/**
 * /read/[id] on a box (docs/box-oauth.md, "Flags on a box"). The box's server
 * reads its own local D1 and has no session, so its flags and owner role are
 * not the account's: the live-draft gate is decided again from production's
 * flags and owner role for the bound account, which BoxApiBridge read from
 * lianki.com before the page rendered. Off a box this component is not used.
 */
import { useFlagView } from "@/app/components/BoxApiBridge";
import type { FlagValues } from "@/lib/flags";
import { draftAllowedFor } from "@/lib/read/reader-access";
import { ReaderV2 } from "./ReaderV2";

export function BoxReader({
  id,
  isLoggedIn,
  streaming,
  serverFlags,
  serverOwner,
}: {
  id: string;
  isLoggedIn: boolean;
  streaming: boolean;
  serverFlags: FlagValues | null;
  serverOwner: boolean;
}) {
  const { flags, owner } = useFlagView({ flags: serverFlags, owner: serverOwner });
  return (
    <ReaderV2
      id={id}
      isLoggedIn={isLoggedIn}
      streaming={streaming}
      draftAllowed={draftAllowedFor(flags, owner)}
    />
  );
}
