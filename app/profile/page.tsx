import { authUser, getSession } from "@/lib/auth-utils";

export default async function ProfilePage() {
  const user = await authUser();
  const session = await getSession();

  return (
    <>
      Email: {user.email}
      <br />
      {JSON.stringify(session)}
      <form
        action={async (fd: FormData) => {
          "use server";
          // TODO: Implement email change with better-auth
          // This will require implementing custom email update logic
          console.log("Email change:", fd.get("email"));
        }}
      >
        <input defaultValue={user.email} name="email" type="email" />
        <button type="submit">Change Email</button>
      </form>
      <a href="/api/auth/signin/github">
        <button type="button">Link Github</button>
      </a>
      <form
        action={async () => {
          "use server";
          // TODO: Implement password update with better-auth
          // This will require implementing custom password update logic
          console.log("Password update requested");
        }}
      >
        Password: {user.emailVerified ? "***" : "No Password yet"}
        <input name="password" type="password" />
        <input name="confirm-password" type="password" />
        <button type="submit">Update Password</button>
      </form>
    </>
  );
}
