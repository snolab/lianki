import { getAuthenticatedEmail } from "@/app/auth-utils";
import { fsrsHandler } from "../../fsrs";
export const dynamic = "force-dynamic";
// export const runtime = 'edge'
export const GET = async (req: Request) => {
  try {
    const email = await getAuthenticatedEmail(req);
    return await fsrsHandler(req, email);
  } catch (error) {
    console.error(error);
    return new Response("Authentication required", { status: 401 });
  }
};

export const POST = async (req: Request) => {
  try {
    const email = await getAuthenticatedEmail(req);
    return await fsrsHandler(req, email);
  } catch (error) {
    console.error(error);
    return new Response("Authentication required", { status: 401 });
  }
};

export const DELETE = async (req: Request) => {
  try {
    const email = await getAuthenticatedEmail(req);
    return await fsrsHandler(req, email);
  } catch (error) {
    console.error(error);
    return new Response("Authentication required", { status: 401 });
  }
};
