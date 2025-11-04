// 1. create password

import { authUser, getSession } from "../signInEmail";

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
      {JSON.stringify(await getSession())}
      <form
        action={async () => {
          "use server";
          // TODO: Implement email change with better-auth
        }}
      >
        <input name="email" type="email" />
        <button type="submit">Change Email</button>
      </form>
      <button
        onClick={async () => {
          "use server";
          await authUser();
          // TODO: Implement GitHub linking with better-auth
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
        Password: {"***" /* Password field not exposed in better-auth */}
        <input name="password" type="password" />
        <input name="confirm-password" type="password" />
        <button type="submit">Update Password</button>
      </form>
    </>
  );
}
