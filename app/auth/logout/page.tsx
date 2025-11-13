import { redirect } from "next/navigation";
import { authEmail } from "@/app/signInEmail";

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
        // Redirect to the auth signout endpoint
        redirect("/api/auth/sign-out");
      }}
    >
      {email}
      <button type="submit">logout</button>
    </form>
  );
}
