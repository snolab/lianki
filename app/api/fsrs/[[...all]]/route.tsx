import { fsrsHandler } from "@/app/fsrs";
import { authEmailOrToken } from "@/lib/authEmailOrToken";

export const dynamic = "force-dynamic";
// export const runtime = 'edge'

const handle = async (req: Request) => {
  const email = await authEmailOrToken(req);
  if (!email) return Response.json({ error: "Login required" }, { status: 401 });
  return fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const PATCH = handle;
