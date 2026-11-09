import { listMyFiles } from "@/lib/import/files";
import { importFilesDeps } from "@/app/api/import/files/deps";

export const dynamic = "force-dynamic";

/** GET /api/my/files: every file the user stored, from every source (/my/files). */
export const GET = () => listMyFiles(importFilesDeps());
