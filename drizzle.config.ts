import { defineConfig } from "drizzle-kit";

const DATA_DIR = process.env.DATA_DIR || ".";

export default defineConfig({
     schema: "./src/server/db/schema.ts",
     out: "./drizzle",
     dialect: "sqlite",
     dbCredentials: {
          url: `${DATA_DIR}/data/db.sqlite`,
     },
});
