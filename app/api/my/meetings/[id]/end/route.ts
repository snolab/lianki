import { answer, jsonBody, meetingDeps } from "@/lib/meetings/gate";
import { endMeeting } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

/** Stop a meeting: `ended`, or `{interrupted: true}` for left-over pieces sent on a later visit. */
export const POST = async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const body = await jsonBody(req, 1_024);
  if (body instanceof Response) return body;
  return answer(await endMeeting(d, (await ctx.params).id, body));
};
