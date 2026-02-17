// import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
// import PostgresAdapter from "@auth/pg-adapter";
// import { Pool } from "@neondatabase/serverless";

import NextAuth from "next-auth";
import { mongoClient } from "./app/db";
import { authConfig } from "./auth.config";

declare module "next-auth" {
  interface User {
    password?: string;
  }
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}
export const { handlers, signIn, signOut, auth } = NextAuth(() => {
  // const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return {
    adapter: MongoDBAdapter(mongoClient),
    // adapter: DrizzleAdapter(db),
    // adapter: PostgresAdapter(pool),
    // pages: {
    //   // signIn: '/auth/signin',
    //   // signOut: '/auth/signout',
    //   // error: '/auth/error',
    //   // verifyRequest: '/auth/verify-request',
    //   // newUser: '/auth/new-user'
    // },
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
        session.user.id = token.id as string;
        return session;
      },
    },

    session: { strategy: "jwt" },
    // force JWT session with a database
    ...authConfig,
  };
});
