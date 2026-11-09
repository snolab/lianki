import { deleteMyFile, readMyFile } from "@/lib/import/files";
import { importFilesDeps } from "@/app/api/import/files/deps";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET: one of the user's own files, to them only (404 for anyone else). */
export const GET = async (_req: Request, ctx: Ctx) =>
  readMyFile((await ctx.params).id, importFilesDeps());

/** DELETE: one of the user's own files, any source, for good (the R2 object and its row). */
export const DELETE = async (req: Request, ctx: Ctx) =>
  deleteMyFile(req, (await ctx.params).id, importFilesDeps());
