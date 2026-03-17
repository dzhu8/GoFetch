const Database = require('better-sqlite3');
const fs = require('fs');

const db = new Database('./data/db.sqlite');
const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_folder_links'").get();
if (!exists) {
  db.exec(fs.readFileSync('./drizzle/0003_add_paper_folder_links.sql', 'utf-8'));
  console.log('Migration applied: paper_folder_links table created.');
} else {
  console.log('Table already exists, skipped.');
}
