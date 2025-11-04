import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";

// Conditionally load MongoDB client
// biome-ignore lint/suspicious/noExplicitAny: Required for dynamic database import
let database: any = null;

try {
  if (process.env.MONGODB_URI) {
    // biome-ignore lint/style/noCommonJs: Required for conditional database import during build
    const { db } = require("./app/db");
    database = db;
  }
} catch {
  console.warn("Database connection not available during build");
}

export const auth = betterAuth({
  database: database ? mongodbAdapter(database) : undefined,
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    ...(process.env.AUTH_GITHUB_SECRET && process.env.AUTH_GITHUB_ID
      ? {
          github: {
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
          },
        }
      : {}),
    ...(process.env.AUTH_GOOGLE_SECRET && process.env.AUTH_GOOGLE_ID
      ? {
          google: {
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
          },
        }
      : {}),
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 1 day
  },
  secret:
    process.env.BETTER_AUTH_SECRET ??
    process.env.AUTH_SECRET ??
    "fallback-secret-key",
  baseURL:
    process.env.BETTER_AUTH_URL ??
    process.env.NEXTAUTH_URL ??
    "http://localhost:3000",
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
