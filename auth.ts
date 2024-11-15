import { DrizzleAdapter } from "@auth/drizzle-adapter";
// import { MongoDBAdapter } from "@auth/mongodb-adapter";
import NextAuth from "next-auth";
// import { mongoClient } from "./app/db";
import { authConfig } from "./auth.config";
import { db } from "./schema";
declare module "next-auth" {
  interface User {
    password?: string;
  }
}
export const { handlers, signIn, signOut, auth } = NextAuth({
  // adapter: MongoDBAdapter(mongoClient),
  adapter: DrizzleAdapter(db),
  pages: {
    // signIn: '/auth/signin',
    // signOut: '/auth/signout',
    // error: '/auth/error',
    // verifyRequest: '/auth/verify-request',
    // newUser: '/auth/new-user'
  },
  // callbacks: {
  //   jwt: async ({ token, user }) => {
  //     if (user) {
  //       token.id = user.id;
  //     }
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
