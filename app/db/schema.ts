import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  github_id: integer("github_id").notNull().unique(),
  github_login: text("github_login").notNull(),
  github_name: text("github_name"),
  github_email: text("github_email"),
  encrypted_access_token: text("encrypted_access_token").notNull(),
  encrypted_refresh_token: text("encrypted_refresh_token").notNull(),
  access_token_expires_at: text("access_token_expires_at").notNull(), // ISO 8601
  refresh_token_expires_at: text("refresh_token_expires_at").notNull(),
  language_preference: text("language_preference").default("en"),
  created_at: text("created_at").$defaultFn(() => new Date().toISOString()),
  updated_at: text("updated_at").$defaultFn(() => new Date().toISOString()),
});
