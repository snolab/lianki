import { NextResponse } from "next/server";
import { authUserOrNull } from "@/app/signInEmail";
import { cfg } from "@/lib/config-store";
import { flagIn } from "@/lib/flags";
import { readFlags } from "@/lib/flags-store";
import { isDev } from "@/lib/permissions";

/**
 * Whether the owner's page should turn the voiceprint filter on for its local
 * STT socket (flag `stt.voiceprint-filter`; docs/local-stt.md, "Only my voice"),
 * and whether the Mac should tag our own TTS voices as "self" (`selfVoice`:
 * flag `stt.self-voice` with the lines stt.selfAccept / stt.selfMargin;
 * docs/echo-suppression.md, layer (c)). Owner session only; 404 for anyone
 * else, as every /api/dev route. Both act on the Mac and only ever on his own
 * route: this answers nothing else.
 */
export const GET = async () => {
  const user = await authUserOrNull();
  if (!isDev(user?.email)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const flags = await readFlags();
  const selfOn = flagIn(flags, "stt.self-voice");
  return NextResponse.json(
    {
      on: flagIn(flags, "stt.voiceprint-filter"),
      selfVoice: selfOn
        ? {
            on: true,
            accept: await cfg("stt.selfAccept").catch(() => undefined),
            margin: await cfg("stt.selfMargin").catch(() => undefined),
          }
        : { on: false },
    },
    { headers: { "cache-control": "no-store" } },
  );
};
