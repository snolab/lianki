import { MongoDBAdapter } from "@auth/mongodb-adapter";
import NextAuth from "next-auth";
import { mongoClient } from "./app/db";
import { authConfig } from "./auth.config";
export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: MongoDBAdapter(mongoClient),
  // callbacks: {
  //   jwt: async ({ token, user }) => {
  //     if (user) {
  //       token.id = user.id;
  //     }f
  //     return token;
  //   },
  // },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        // User is available during sign-in
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      // @ts-expect-error any
      session.user.id = token.id;
      return session;
    },
  },
  session: { strategy: "jwt" }, // force JWT session with a database
  ...authConfig,
});
