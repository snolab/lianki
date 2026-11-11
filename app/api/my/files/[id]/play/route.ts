import { mintPlayUrl, servePlay, type PlayUrlDeps } from "@/lib/import/play-url";
import { importFilesDeps } from "@/app/api/import/files/deps";
import { readFlags } from "@/lib/flags-store";
import { flagIn } from "@/lib/flags";
import { PLAY_FLAG } from "@/packages/debug-chat/src/play-audio";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** My Files' gate (any source) and the flag chat.play-audio (docs/li-sound-hub.md). */
const deps = (): PlayUrlDeps => {
  const files = importFilesDeps();
  return {
    ...files,
    on: async (who) => flagIn(await readFlags(), PLAY_FLAG) && (await files.on(who, "any")),
    secret: () => process.env.AUTH_SECRET,
  };
};

/** POST: a short-lived URL that plays one of the user's own audio files. */
export const POST = async (req: Request, ctx: Ctx) =>
  mintPlayUrl(req, (await ctx.params).id, deps());

/** GET ?exp&sig: that file, inline, with byte ranges, until the URL expires. */
export const GET = async (req: Request, ctx: Ctx) => servePlay(req, (await ctx.params).id, deps());
