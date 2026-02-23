/**
 * One-shot migration: fix the `papers` table foreign key.
 *
 * The original migration incorrectly referenced `folders` (code-analysis folders)
 * instead of `library_folders`. SQLite does not support altering foreign keys
 * in-place, so the table is rebuilt via a rename-copy-drop cycle.
 *
 * Safe to re-run: a second run detects that the FK is already correct and exits.
 *
 * Usage:  node scripts/fix-papers-fk.js
 */

const Database = require("better-sqlite3");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || ".";
const db = new Database(path.join(DATA_DIR, "data", "db.sqlite"));

// Check current FK target
const tableInfo = db
     .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='papers'")
     .get();

if (!tableInfo) {
     console.log("No `papers` table found — nothing to do.");
     process.exit(0);
}

if (tableInfo.sql.includes("REFERENCES `library_folders`")) {
     console.log("`papers` FK already references `library_folders` — nothing to do.");
     process.exit(0);
}

console.log("Fixing `papers` FK: folders → library_folders …");

db.pragma("foreign_keys = OFF");

db.exec(`
CREATE TABLE \`papers_new\` (
     \`id\` integer PRIMARY KEY NOT NULL,
     \`folder_id\` integer NOT NULL,
     \`file_name\` text NOT NULL,
     \`file_path\` text NOT NULL,
     \`title\` text,
     \`doi\` text,
     \`abstract\` text,
     \`semantic_scholar_id\` text,
     \`semantic_scholar_citation\` text,
     \`first_figure_path\` text,
     \`status\` text DEFAULT 'uploading' NOT NULL,
     \`created_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
     \`updated_at\` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
     FOREIGN KEY (\`folder_id\`) REFERENCES \`library_folders\`(\`id\`) ON UPDATE no action ON DELETE cascade
);

INSERT INTO \`papers_new\` SELECT * FROM \`papers\`;

DROP TABLE \`papers\`;

ALTER TABLE \`papers_new\` RENAME TO \`papers\`;
`);

db.pragma("foreign_keys = ON");

// Verify
const updated = db
     .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='papers'")
     .get();

if (updated.sql.includes("library_folders")) {
     console.log("Done. `papers` FK now references `library_folders`.");
} else {
     console.error("Something went wrong — FK was not updated.");
     process.exit(1);
}
