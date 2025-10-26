// 1. create password

import { auth, signIn } from "@/auth";
import { authUser } from "../signInEmail";

// 2. link oauth
export default async function ProfilePage() {
  //
  // /onborarding/step1-create-password
  // /onborarding/step2-link-oauth
  // /onborarding/step3-tutorial

  const user = await authUser();

  return (
    <>
      Email: {user.email}
      <br />
      {JSON.stringify(await auth())}
      <form
        action={async (fd: FormData) => {
          "use server";
          await signIn("nodemailer", fd);
        }}
      >
        <input name="email" type="email" />
        <button type="submit">Change Email</button>
      </form>
      <button
        onClick={async () => {
          "use server";
          await authUser();
          await signIn("github");
        }}
        type="button"
      >
        Link Github
      </button>
      <form
        action={async () => {
          "use server";
          // const user = await authUser()

          // user.password
        }}
      >
        Password: {user.password ? "***" : "No Password yet"}
        <input name="password" type="password" />
        <input name="confirm-password" type="password" />
        <button type="submit">Update Password</button>
      </form>
    </>
  );
}
