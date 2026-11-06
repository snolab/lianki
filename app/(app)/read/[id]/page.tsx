import { ReadViewClient } from "./ReadViewClient";
import { ReaderV2 } from "./ReaderV2";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { readerPick } from "@/lib/read/reader-access";
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
  const pick = readerPick({
    flags,
    owner: isOwner(user?.email),
    dev: process.env.NODE_ENV === "development",
    query: query.reader,
  });

  // The reader v2 fills the screen: the window scrolls the whole book.
  if (pick === "v2")
    return (
      <ReaderV2 id={id} isLoggedIn={!!user} streaming={query.streamingFrom === "google-docs"} />
    );

  return (
    <div className="flex flex-col">
      <div className="flex-grow px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-4xl mx-auto">
          <ReadViewClient id={id} isLoggedIn={!!user} />
        </div>
      </div>
    </div>
  );
}
