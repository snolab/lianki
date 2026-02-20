import { auth } from "@/auth";
import { authEmail } from "@/app/signInEmail";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

/**
 *
 * @author: snomiao <snomiao@gmail.com>
 */
export default async function Logout() {
  const email = await authEmail();
  return (
    <form
      action={async () => {
        "use server";
        await auth.api.signOut({ headers: await headers() });
        redirect("/");
      }}
    >
      {email}
      <button>logout</button>
    </form>
  );
}
