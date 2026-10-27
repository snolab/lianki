import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { WordsD1Repo } from "@/lib/repos/wordsD1";

/**
 * The signed-in user's word lists, or the error response to return instead.
 *
 * D1 only: word lists arrived after the cutover, and MongoDB is a frozen
 * rollback copy, so there is no Mongo store to keep in step.
 */
export async function wordsRepo(): Promise<WordsD1Repo | NextResponse> {
  const user = await authUserOrNull();
  if (!user?.email) return NextResponse.json({ error: "Login required" }, { status: 401 });
  if (dbBackend() !== "d1")
    return NextResponse.json({ error: "Word lists need the D1 backend" }, { status: 503 });
  return new WordsD1Repo(getD1(), user.email);
}
