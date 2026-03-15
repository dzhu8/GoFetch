#!/usr/bin/env node
/**
 * One-time migration: create the related_papers table.
 * Run with: node scripts/create-related-papers-table.js
 */
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..");
const dbPath = path.join(DATA_DIR, "data", "db.sqlite");

console.log("Opening database at:", dbPath);
const db = new Database(dbPath);

db.exec(`
CREATE TABLE IF NOT EXISTS related_papers (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     paper_id    INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
     title       TEXT    NOT NULL,
     authors     TEXT,
     year        INTEGER,
     venue       TEXT,
     abstract    TEXT,
     doi         TEXT,
     semantic_scholar_id TEXT,
     relevance_score     REAL,
     bc_score            REAL,
     cc_score            REAL,
     created_at  TEXT    NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
`);

console.log("related_papers table created (or already existed).");
db.close();
