import { varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/neon-http";
import { integer, pgTable } from "drizzle-orm/pg-core";
import DIE from "phpdie";
export const pg = drizzle(process.env.DATABASE_URL ?? DIE(""));
export const usersTable = pgTable("users", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 255 }).notNull(),
  age: integer().notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
});
