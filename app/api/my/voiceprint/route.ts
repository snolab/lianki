import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { dbBackend, getD1 } from "@/lib/d1";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";
import {
  type CloudDeps,
  d1VoiceprintDb,
  deletePrints,
  listPrints,
  putPrints,
  voiceprintKey,
} from "@/lib/voiceprint-cloud";
import { importTicketVerifyKey } from "@/lib/voiceprint-ticket";

export const dynamic = "force-dynamic";

/**
 * The signed-in account's own voiceprint features (lib/voiceprint-cloud.ts;
 * docs/local-stt.md, "Voiceprint in your account"). The session cookie only:
 * no API token reads or writes it. 404 unless the flag `stt.voiceprint-cloud`
 * is on and the account holds `dev` (the same grant the voiceprint tickets
 * need); 503 off D1 or without the secrets.
 */
const NO_STORE = { "cache-control": "no-store" };
const notFound = () =>
  NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE });

async function deps(): Promise<CloudDeps | NextResponse> {
  const user = await authUserOrNull();
  if (!user?.id || !isDev(user.email)) return notFound();
  if (!flagIn(await readFlags(), "stt.voiceprint-cloud")) return notFound();
  const raw = process.env.STT_TICKET_KEY;
  if (!raw || dbBackend() !== "d1")
    return NextResponse.json(
      { error: "voiceprint storage is off" },
      { status: 503, headers: NO_STORE },
    );
  return {
    uid: user.id as string,
    db: d1VoiceprintDb(getD1()),
    key: () => voiceprintKey(process.env.AUTH_SECRET),
    pub: () => importTicketVerifyKey(raw),
  };
}

const answer = (o: { status: number; json: Record<string, unknown> }) =>
  NextResponse.json(o.json, { status: o.status, headers: NO_STORE });
const body = async (req: Request) => {
  try {
    return await req.json();
  } catch {
    return null;
  }
};

export const GET = async (req: Request) => {
  const d = await deps();
  if (d instanceof NextResponse) return d;
  return answer(await listPrints(d, new URL(req.url).searchParams.get("features") === "1"));
};

export const PUT = async (req: Request) => {
  const d = await deps();
  if (d instanceof NextResponse) return d;
  return answer(await putPrints(d, await body(req)));
};

export const DELETE = async (req: Request) => {
  const d = await deps();
  if (d instanceof NextResponse) return d;
  return answer(await deletePrints(d, await body(req)));
};
