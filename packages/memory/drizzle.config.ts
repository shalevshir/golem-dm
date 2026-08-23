import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  // Only `db:migrate` needs credentials; `db:generate` diffs offline. An
  // unset DATABASE_URL therefore fails at migrate time with a connection
  // error rather than here.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
