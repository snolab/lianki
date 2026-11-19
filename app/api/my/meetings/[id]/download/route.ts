import { NO_STORE, answer, meetingDeps } from "@/lib/meetings/gate";
import { bad, downloadAv, transcriptFile } from "@/lib/meetings/store";

export const dynamic = "force-dynamic";

/** The video as one file, streamed piece by piece; `?part=txt|vtt` the transcript. */
export const GET = async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const d = await meetingDeps(req);
  if (d instanceof Response) return d;
  const id = (await ctx.params).id;
  const part = new URL(req.url).searchParams.get("part");
  if (part === "txt" || part === "vtt") {
    const r = await transcriptFile(d, id, part);
    if ("status" in r) return answer(r);
    return new Response(r.text, {
      headers: {
        ...NO_STORE,
        "content-type": part === "vtt" ? "text/vtt; charset=utf-8" : "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${r.name}"`,
      },
    });
  }
  if (part !== null) return answer(bad(400, "bad part"));
  const r = await downloadAv(d, id);
  if ("status" in r) return answer(r);
  return new Response(r.stream, {
    headers: {
      ...NO_STORE,
      "content-type": r.mime,
      "content-disposition": `attachment; filename="${r.name}"`,
      "x-content-type-options": "nosniff",
    },
  });
};
