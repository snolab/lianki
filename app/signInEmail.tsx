import { auth, signIn } from "@/auth";
import DIE from "phpdie";

export async function signInEmail() {
    const session = await auth() ?? await signIn();
    const email = session.user?.email || DIE('this user missing email, why?');
    return email;
}
