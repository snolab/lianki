import { fsrsHandler } from "@/app/fsrs";
import { auth, signIn } from "@/auth";
import DIE from "phpdie";

export async function fsrsHandlerWithAuth(req: Request) {
    const session = (await auth()) ?? await signIn();
    const email = session?.user?.email ?? DIE('');
    return await fsrsHandler(req, email).catch((error) => {
        console.error(error); return new Response('sth wrong', { status: 500 });
    });
}
