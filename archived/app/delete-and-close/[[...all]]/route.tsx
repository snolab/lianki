import { authEmail } from "@/app/signInEmail";
import { fsrsHandler } from "../../fsrs";
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
