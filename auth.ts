import { MongoDBAdapter, defaultCollections } from "@auth/mongodb-adapter";
import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
import DIE from "phpdie";
import sha256 from "sha256";
import { db, mongoClient } from "./app/db";
const Users = db.collection<{
  email: string;
  hashedPassword: string;
}>(defaultCollections.Users);

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: MongoDBAdapter(mongoClient),
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
  },
  providers: [
    ...(process.env.EMAIL_SERVER
      ? [
          Nodemailer({
            name: "Email",
            server: process.env.EMAIL_SERVER,
            from: process.env.EMAIL_FROM,
          }),
        ]
      : []),
    ...(process.env.AUTH_GITHUB_SECRET ? [GitHub] : []),
    ...(process.env.AUTH_GOOGLE_SECRET ? [Google] : []),
    CredentialsProvider({
      credentials: {
        email: { type: "text" },
        password: { type: "password" },
      },
      async authorize(credentials) {
        const crd = credentials as { email: string; password: string };
        const hashPassword = (
          password: string,
          salt = process.env.AUTH_SECRET
        ) => sha256(salt + password);
        return (
          (await Users.findOne({
            email: crd.email,
            password: hashPassword(crd.password),
          })) ?? DIE("user not found")
        );
        // ...
      },
    }),
  ],
});
