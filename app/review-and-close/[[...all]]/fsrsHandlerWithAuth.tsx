import { fsrsHandler } from "@/app/fsrs";
import { authEmail } from "@/app/signInEmail";

export async function fsrsHandlerWithAuth(req: Request) {
  const email = await authEmail();
  return await fsrsHandler(req, email).catch((error) => {
    console.error(error);
    return new Response("sth wrong", { status: 500 });
  });
}
