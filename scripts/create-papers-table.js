const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'data/db.sqlite'));
db.pragma('foreign_keys = ON');

// Create library_folders table (separate from codebase analytics folders)
db.exec(`
  CREATE TABLE IF NOT EXISTS library_folders (
    id integer PRIMARY KEY NOT NULL,
    name text NOT NULL,
    root_path text NOT NULL,
    created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
  )
`);

// Create unique index on library_folders.name
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS library_folders_name_idx ON library_folders (name)`);
} catch (e) {
  // Index may already exist
}

// Drop and recreate papers table to reference library_folders instead of folders
db.exec(`DROP TABLE IF EXISTS papers`);
db.exec(`
  CREATE TABLE papers (
    id integer PRIMARY KEY NOT NULL,
    folder_id integer NOT NULL,
    file_name text NOT NULL,
    file_path text NOT NULL,
    title text,
    doi text,
    abstract text,
    semantic_scholar_id text,
    semantic_scholar_citation text,
    first_figure_path text,
    status text DEFAULT 'uploading' NOT NULL,
    created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (folder_id) REFERENCES library_folders(id) ON UPDATE no action ON DELETE cascade
  )
`);

console.log('library_folders and papers tables created successfully');
db.close();
