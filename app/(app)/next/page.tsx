import { authEmail } from "@/app/signInEmail";
import NextCardClient from "./NextCardClient";

// Which deck has the next card is a per-browser question — the local mirror is
// only readable client-side — so this page cannot be cached.
export const dynamic = "force-dynamic";

export default async function NextPage() {
  let isLoggedIn = false;
  try {
    isLoggedIn = Boolean(await authEmail());
  } catch {
    // Guest: the local deck is the only one there is.
  }
  return <NextCardClient isLoggedIn={isLoggedIn} listHref="/list" />;
}
