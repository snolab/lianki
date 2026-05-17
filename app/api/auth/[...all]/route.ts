import { getAuth } from "@/auth";
import { toNextJsHandler } from "better-auth/next-js";

// getAuth() is resolved per-request so the D1 binding (request-scoped) is
// available when DB_BACKEND=d1.
export const GET = (req: Request) => toNextJsHandler(getAuth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(getAuth()).POST(req);
export const dynamic = "force-dynamic";
