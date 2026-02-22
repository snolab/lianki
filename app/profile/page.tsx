import { auth } from "@/auth";
import { headers } from "next/headers";
import { authUser } from "../signInEmail";

export default async function ProfilePage() {
  const user = await authUser();
  const session = await auth.api.getSession({ headers: await headers() });

  return (
    <div>
      <h1>Profile</h1>
      <div>
        <h2>User Information</h2>
        <p>
          <strong>Name:</strong> {user.name || "N/A"}
        </p>
        <p>
          <strong>Email:</strong> {user.email}
        </p>
        {user.image && (
          <p>
            <strong>Avatar:</strong> <img src={user.image} alt="User avatar" />
          </p>
        )}
      </div>
      <div>
        <h2>Session Details</h2>
        <pre>{JSON.stringify(session, null, 2)}</pre>
      </div>
      <div>
        <a href="/preferences" className="text-blue-500 hover:text-blue-600 mr-4">
          Edit Preferences
        </a>
        <a href="/list" className="text-blue-500 hover:text-blue-600">
          Back to Home
        </a>
      </div>
    </div>
  );
}
