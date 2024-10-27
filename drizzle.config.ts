import { defineConfig } from "drizzle-kit";
import DIE from "phpdie";
export default defineConfig({
  out: "./drizzle",
  schema: "./schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || DIE("Missing URL"),
  },
});
