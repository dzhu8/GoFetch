import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const sqlite = new Database(path.join(DATA_DIR, "./data/db.sqlite"));
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite, {
     schema: schema,
});

// Ensure cache tables exist — these are created inline rather than via a
// migration so they are available immediately without running drizzle-kit.
sqlite.exec(`
     CREATE TABLE IF NOT EXISTS paper_edge_cache (
          paper_id TEXT PRIMARY KEY NOT NULL,
          references_json TEXT,
          citations_json TEXT,
          fetched_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS paper_metadata_cache (
          paper_id TEXT PRIMARY KEY NOT NULL,
          data_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS paper_abstract_embeddings (
          paper_id   TEXT    NOT NULL,
          model_key  TEXT    NOT NULL,
          embedding  BLOB    NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (paper_id, model_key)
     );
`);

export default db;
