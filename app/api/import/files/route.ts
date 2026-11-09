import { listImportFiles, uploadImportFile } from "@/lib/import/files";
import { importFilesDeps } from "./deps";

export const dynamic = "force-dynamic";

/**
 * The user's file store (lib/import/files.ts): POST stores one file (raw
 * body, `x-file-name`, `?source=import|self-intro`), GET lists the user's
 * stored files from one source. Stored only, never processed here.
 */
export const POST = (req: Request) => uploadImportFile(req, importFilesDeps());
export const GET = (req: Request) => listImportFiles(importFilesDeps(), req);
