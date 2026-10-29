import { getAuth } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";

// getAuth() is resolved per-request so the D1 binding (request-scoped) is
// available when DB_BACKEND=d1.
export const GET = async (req: Request) => toNextJsHandler(await getAuth()).GET(req);
export const POST = async (req: Request) => toNextJsHandler(await getAuth()).POST(req);
export const dynamic = "force-dynamic";
