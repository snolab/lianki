import { fsrsHandler } from "@/app/fsrs";
import { authEmail } from "@/app/signInEmail";
export const dynamic = "force-dynamic";
// export const runtime = 'edge'
export const GET = async (req: Request) => {
  const email = await authEmail();
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
export const POST = async (req: Request) => {
  const email = await authEmail();
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
export const DELETE = async (req: Request) => {
  const email = await authEmail();
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
export const PATCH = async (req: Request) => {
  const email = await authEmail();
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
};
