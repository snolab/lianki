import { ReaderV2 } from "./ReaderV2";
import { BoxReader } from "./BoxReader";
import { authUserOrNull } from "@/app/signInEmail";
import { boxConfig } from "@/lib/box-oauth/mode";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { draftAllowedFor } from "@/lib/read/reader-access";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { resolveReadId } from "@/lib/read/book-link";
import { findReadMaterialIdByHash } from "@/lib/getReadMaterialsCollection";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReadMaterialPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, query, user, flags] = await Promise.all([
    params,
    searchParams,
    authUserOrNull(),
    readFlags(),
  ]);
  // A deep link names the book by its content hash: open the reader's own
  // copy of that text, or 404 (lib/read/book-link.ts). The browser keeps the
  // link's #fragment across the redirect.
  const target = await resolveReadId(id, user?.id, findReadMaterialIdByHash);
  if (target.kind === "none") notFound();
  if (target.kind === "redirect") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
    redirect(`/read/${encodeURIComponent(target.id)}${q.size ? `?${q}` : ""}`);
  }
  const owner = isOwner(user?.email);
  const streaming = query.streamingFrom === "google-docs" || query.streamingFrom === "vibe";

  // On a box this server's flags are its local D1's and it has no session: the
  // live-draft gate is decided in the browser from production's flags for the
  // bound account instead (docs/box-oauth.md, "Flags on a box").
  if (boxConfig())
    return (
      <BoxReader
        id={id}
        isLoggedIn={!!user}
        streaming={streaming}
        serverFlags={flags}
        serverOwner={owner}
      />
    );

  // The reader fills the screen: the window scrolls the whole book.
  return (
    <ReaderV2
      id={id}
      isLoggedIn={!!user}
      streaming={streaming}
      draftAllowed={draftAllowedFor(flags, owner)}
      ytSongs={!!user && ytSongsOn(flags, owner)}
    />
  );
}
