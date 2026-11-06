import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isOwner } from "@/lib/owner";

/**
 * Whether the owner's page should turn the voiceprint filter on for its local
 * STT socket (flag `stt.voiceprint-filter`; docs/local-stt.md, "Only my voice").
 * Owner session only; 404 for anyone else, as every /api/dev route. The filter
 * is on the Mac and only ever on his own route: this answers nothing else.
 */
export const GET = async () => {
  const user = await authUserOrNull();
  if (!isOwner(user?.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(
    { on: flagIn(await readFlags(), "stt.voiceprint-filter") },
    { headers: { "cache-control": "no-store" } },
  );
};
