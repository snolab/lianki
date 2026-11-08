import { notFound, redirect } from "next/navigation";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { YtSongNew } from "./YtSongNew";

export const dynamic = "force-dynamic";

/**
 * /read/youtube: a YouTube song with timed lyrics into /read
 * (docs/youtube-song-examples.md, M1). `read.youtube-songs`, or the owner;
 * 404 to anyone else. Signed in only: the lyrics live in his account.
 */
export default async function YtSongPage() {
  const user = await authUserOrNull();
  if (dbBackend() !== "d1") notFound();
  if (!user) redirect("/sign-in");
  if (!ytSongsOn(await readFlags(), isOwner(user.email ?? null))) notFound();
  return (
    <div className="px-4 sm:px-6 lg:px-8 py-8">
      <div className="mx-auto max-w-2xl">
        <YtSongNew />
      </div>
    </div>
  );
}
