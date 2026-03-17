const db = require('better-sqlite3')('./data/db.sqlite');
const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='paper_folder_links'").get();
console.log(row ? row.sql : 'TABLE NOT FOUND');
