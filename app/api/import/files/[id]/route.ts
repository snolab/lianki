import { deleteImportFile } from "@/lib/import/files";
import { importFilesDeps } from "../deps";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/import/files/<id>: one of the user's own stored files, for good. */
export const DELETE = async (req: Request, ctx: Ctx) =>
  deleteImportFile(req, (await ctx.params).id, importFilesDeps());
