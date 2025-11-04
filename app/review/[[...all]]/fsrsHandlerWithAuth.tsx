import { getAuthenticatedEmail } from "@/app/auth-utils";
import { fsrsHandler } from "@/app/fsrs";

export async function fsrsHandlerWithAuth(req: Request) {
  try {
    const email = await getAuthenticatedEmail(req);
    return await fsrsHandler(req, email).catch((error) => {
      console.error(error);
      return new Response("sth wrong", { status: 500 });
    });
  } catch (error) {
    console.error("Authentication error:", error);
    return new Response("Unauthorized", { status: 401 });
  }
}
