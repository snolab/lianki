import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, authEmail } from "@/auth";

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
        await auth.api.signOut({
          headers: await headers(),
        });
        redirect("/");
      }}
    >
      {email}
      <button type="submit">logout</button>
    </form>
  );
}
