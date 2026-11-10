import { ReadListClient } from "./ReadListClient";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { connectionsOn } from "@/lib/connections/gate";
import { libraryOn } from "@/lib/books/gate";
import { vibeAllowed } from "@/lib/vibe/gate";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { VibeEntry } from "../vibe/VibeDocNote";

/**
 * /reader's first screen, phone first: a compact header with the one Import
 * button (every way in sits in its pop-up), "Continue reading", then the
 * reading list. Signed out: a short welcome with sign-in and the library.
 */
export default async function ReadPage() {
  const user = await authUserOrNull();
  // Flags are read on D1 for everyone: /library is public.
  const flags = dbBackend() === "d1" ? await readFlags() : null;
  const owner = isDev(user?.email ?? null);
  // Google Docs import: signed in on D1, as its route (app/api/read/gdoc).
  const gdoc = !!user && !!flags;
  // Private docs through the Google connection (docs/connections.md).
  const drive = gdoc && connectionsOn(flags, owner);
  // The link to /library, the catalogue (library.catalogue, or `dev`).
  const books = !!flags && libraryOn(flags, owner);
  // A YouTube song with timed lyrics (read.youtube-songs, or the owner).
  const youtube = !!user && !!flags && ytSongsOn(flags, owner);

  return (
    <div className="px-4 sm:px-6 lg:px-8 pt-4 pb-8 sm:pt-8">
      <div className="max-w-4xl mx-auto">
        <ReadListClient
          isLoggedIn={!!user}
          gdoc={gdoc}
          drive={drive}
          books={books}
          youtube={youtube}
          extra={!!user && !!flags && vibeAllowed(flags, owner) ? <VibeEntry /> : null}
        />
      </div>
    </div>
  );
}
