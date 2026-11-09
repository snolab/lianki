import { listImportFiles, uploadImportFile } from "@/lib/import/files";
import { importFilesDeps } from "./deps";

export const dynamic = "force-dynamic";

/**
 * The Import panel's "Any file" (lib/import/files.ts): POST stores one file
 * (raw body, `x-file-name`), GET lists the user's stored files. Stored only,
 * never processed.
 */
export const POST = (req: Request) => uploadImportFile(req, importFilesDeps());
export const GET = () => listImportFiles(importFilesDeps());
