import { answer, jsonBody, meetingDeps } from "@/lib/meetings/gate";
import { deleteMeeting, getMeeting, patchMeeting } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** One meeting (docs/meetings.md): GET it with its pieces, PATCH title/transcript, DELETE for good. */
export const GET = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  return answer(await getMeeting(d, (await ctx.params).id));
};

export const PATCH = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const body = await jsonBody(req, 4_096);
  if (body instanceof Response) return body;
  return answer(await patchMeeting(d, (await ctx.params).id, body));
};

export const DELETE = async (req: Request, ctx: Ctx) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  return answer(await deleteMeeting(d, (await ctx.params).id));
};
