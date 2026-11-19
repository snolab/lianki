import { answer, jsonBody, meetingDeps } from "@/lib/meetings/gate";
import { LINE_LIMITS, getLines, putLines } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Transcript lines (docs/meetings.md, "The API for the transcript side").
 * PUT {source, lines, replace?}: one D1 batch; GET: finals plus the live
 * lines no final overlaps.
 */
export const GET = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  return answer(await getLines(d, (await ctx.params).id));
};

export const PUT = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const body = await jsonBody(req, LINE_LIMITS.bodyBytes);
  if (body instanceof Response) return body;
  return answer(await putLines(d, (await ctx.params).id, body));
};
