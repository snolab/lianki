import { answer, jsonBody, meetingDeps } from "@/lib/meetings/gate";
import { createMeeting, listMeetings } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

/** The account's meetings (docs/meetings.md): GET the list, newest first; POST a new one (on a tap). */
export const GET = async (req: Request) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  return answer(await listMeetings(d, new URL(req.url).searchParams));
};

export const POST = async (req: Request) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const body = await jsonBody(req, 8_192);
  if (body instanceof Response) return body;
  return answer(await createMeeting(d, body));
};
