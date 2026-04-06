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
     CREATE TABLE IF NOT EXISTS paper_source_links (
          s2_paper_id    TEXT    NOT NULL,
          source_paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          depth          INTEGER NOT NULL,
          PRIMARY KEY (s2_paper_id, source_paper_id)
     );
     
     CREATE TABLE IF NOT EXISTS doi_related_results_cache (
          s2_paper_id    TEXT    NOT NULL,
          doi            TEXT    NOT NULL,
          rank_method    TEXT    NOT NULL DEFAULT 'bibliographic',
          results_json   TEXT    NOT NULL,
          seed_title     TEXT,
          embedding_model TEXT,
          created_at     INTEGER NOT NULL,
          PRIMARY KEY (s2_paper_id, rank_method)
     );

     CREATE TABLE IF NOT EXISTS extracted_figures (
          id          INTEGER PRIMARY KEY,
          paper_id    INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
          filename    TEXT    NOT NULL,
          page_index  INTEGER NOT NULL,
          doc_order   INTEGER NOT NULL,
          caption     TEXT    NOT NULL DEFAULT '',
          image_data  BLOB    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(paper_id, filename)
     );
`);

// Add depth column to related_papers if it doesn't exist yet (idempotent).
const relatedPapersCols = sqlite.pragma("table_info(related_papers)") as Array<{ name: string }>;
if (!relatedPapersCols.some((c) => c.name === "depth")) {
     sqlite.exec("ALTER TABLE related_papers ADD COLUMN depth integer;");
}

export default db;
