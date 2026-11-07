import { ReadListClient } from "./ReadListClient";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend } from "@/lib/d1";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { connectionsOn } from "@/lib/connections/gate";
import { booksOn } from "@/lib/books/gate";
import { vibeAllowed } from "@/lib/vibe/gate";
import { VibeEntry } from "../vibe/VibeDocNote";

export default async function ReadPage() {
  const user = await authUserOrNull();
  // Google Docs import: signed in on D1, as its route (app/api/read/gdoc).
  const flags = user && dbBackend() === "d1" ? await readFlags() : null;
  const owner = isOwner(user?.email ?? null);
  const gdoc = !!flags;
  // Private docs through the Google connection (docs/connections.md).
  const drive = gdoc && connectionsOn(flags, owner);
  // The link to /books, the public-domain library (books.catalogue, or the owner).
  const books = !!flags && booksOn(flags, owner);

  return (
    <div className="flex flex-col">
      <div className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-bold mb-6">Read & Learn</h1>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            Import text materials for spaced repetition learning.
            {user
              ? " Your materials are stored securely in your account."
              : " Sign in to save your materials."}
          </p>
          {!!flags && vibeAllowed(flags, owner) && <VibeEntry />}
          <ReadListClient isLoggedIn={!!user} gdoc={gdoc} drive={drive} books={books} />
        </div>
      </div>
    </div>
  );
}
