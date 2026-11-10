import { getIntlayer } from "intlayer";
import { ReadListClient } from "./ReadListClient";
import { appLocale } from "@/lib/app-locale.server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import { connectionsOn } from "@/lib/connections/gate";
import { libraryOn } from "@/lib/books/gate";
import { vibeAllowed } from "@/lib/vibe/gate";
import { ytSongsOn } from "@/lib/yt-songs/gate";
import { VibeEntry } from "../vibe/VibeDocNote";

export default async function ReadPage() {
  const user = await authUserOrNull();
  const t = getIntlayer("read-list", await appLocale());
  // Google Docs import: signed in on D1, as its route (app/api/read/gdoc).
  const flags = user && dbBackend() === "d1" ? await readFlags() : null;
  const owner = isDev(user?.email ?? null);
  const gdoc = !!flags;
  // Private docs through the Google connection (docs/connections.md).
  const drive = gdoc && connectionsOn(flags, owner);
  // The link to /library, the catalogue (library.catalogue, or `dev`).
  const books = !!flags && libraryOn(flags, owner);
  // A YouTube song with timed lyrics (read.youtube-songs, or the owner).
  const youtube = !!flags && ytSongsOn(flags, owner);

  return (
    <div className="flex flex-col">
      <div className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-bold mb-6">{t.heading}</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            {t.intro}
            {/* No space after a full-width stop (zh, ja). */}
            {/[。！？]$/.test(String(t.intro)) ? "" : " "}
            {user ? t.storedInAccount : t.signInToSave}
          </p>
          {!!flags && vibeAllowed(flags, owner) && <VibeEntry />}
          <ReadListClient
            isLoggedIn={!!user}
            gdoc={gdoc}
            drive={drive}
            books={books}
            youtube={youtube}
          />
        </div>
      </div>
    </div>
  );
}
