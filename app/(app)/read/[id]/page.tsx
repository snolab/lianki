import { ReadViewClient } from "./ReadViewClient";
import { ReaderV2 } from "./ReaderV2";
import { authUserOrNull } from "@/app/signInEmail";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";
import { devWholePage } from "@/lib/dev-whole-page";
import { readerPick } from "@/lib/read/reader-access";

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
  const pick = readerPick({
    flags,
    owner: isOwner(user?.email),
    devPreview: devWholePage(),
    dev: process.env.NODE_ENV === "development",
    query: query.reader,
  });

  // The reader v2 fills the screen: the window scrolls the whole book.
  if (pick === "v2") return <ReaderV2 id={id} isLoggedIn={!!user} />;

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
