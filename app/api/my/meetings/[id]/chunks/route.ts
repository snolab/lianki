import { answer, meetingDeps } from "@/lib/meetings/gate";
import { chunkIndex } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

/** The stored pieces of one meeting (`?track=me` for one track): seq, startMs, durMs, bytes, fragOff, fragMs. */
export const GET = async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  return answer(
    await chunkIndex(d, (await ctx.params).id, new URL(req.url).searchParams.get("track")),
  );
};
