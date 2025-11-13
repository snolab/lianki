import { auth } from "@/auth";

export const getAuthenticatedEmail = async (req: Request) => {
  const session = await auth.api.getSession({
    headers: req.headers,
  });

  if (!session?.user?.email) {
    throw new Error("User not authenticated or missing email");
  }

  return session.user.email;
};

export const getAuthenticatedUser = async (req: Request) => {
  const session = await auth.api.getSession({
    headers: req.headers,
  });

  if (!session?.user) {
    throw new Error("User not authenticated");
  }

  return session.user;
};
