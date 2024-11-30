import { fsrsHandler } from "@/app/fsrs";
import { auth, signIn } from "@/auth";
import DIE from "phpdie";
export const dynamic = "force-dynamic";
// export const runtime = 'edge'
export const GET = async (req: Request) => {
  const session = (await auth()) ?? (await signIn());
  const email = session?.user?.email ?? DIE("");
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
export const POST = async (req: Request) => {
  const session = (await auth()) ?? (await signIn());
  const email = session?.user?.email ?? DIE("");
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
export const DELETE = async (req: Request) => {
  const session = (await auth()) ?? (await signIn());
  const email = session?.user?.email ?? DIE("");
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
