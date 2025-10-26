import { authEmail } from "@/app/signInEmail";
import { signOut } from "@/auth";

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
        await signOut();
      }}
    >
      {email}
      <button type="submit">logout</button>
    </form>
  );
}
