import type { NextAuthConfig } from "next-auth";
// import { MongoDBAdapter, defaultCollections } from "@auth/mongodb-adapter";

import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";
// import { db } from "./app/db";
// import { db, mongoClient } from "./app/db-edge";
// const Users = db.collection<{
//   email: string;
//   hashedPassword: string;
// }>(defaultCollections.Users);

// const users = db.collection<{
//   email: string;
//   hashedPassword: string;
// }>("users");

export const authConfig = {
  providers: [
    // otl should be used for sign up
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

    // able to use after create password
    // CredentialsProvider({
    //   credentials: {
    //     email: { type: "text", label: "Email" },
    //     password: { type: "password", label: "Password" },
    //   },
    //   async authorize(credentials) {
    //     const crd = credentials as { email: string; password: string };
    //     const hashPassword = (
    //       password: string,
    //       salt = process.env.AUTH_SECRET
    //     ) => sha256(salt + password);
    //     const user = await users.findOne({
    //       email: crd.email,
    //       password: hashPassword(crd.password),
    //     });
    //     console.log({ user });
    //     return user;
    //     // ...
    //   },
    // }),
    // sign up
    // CredentialsProvider({
    //   credentials: {
    //     email: { type: "text", label: "Email" },
    //     password: { type: "password", label: "Password" },
    //     confirm_password: { type: "password", label: "Confirm Password" },
    //   },
    //   async authorize(credentials) {
    //     const crd = credentials as { email: string; password: string };
    //     const hashPassword = (
    //       password: string,
    //       salt = process.env.AUTH_SECRET
    //     ) => sha256(salt + password);
    //     const user = await users.findOne({ email: crd.email });
    //     console.log({ user });
    //     return user;
    //     // ...
    //   },
    // }),
  ],
} satisfies NextAuthConfig;
