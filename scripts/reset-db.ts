import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = process.env.DATA_DIR || process.cwd();
const LIBRARY_ROOT = path.join(DATA_DIR, "data", "library");
const sqlite = new Database(path.join(DATA_DIR, "./data/db.sqlite"));

async function fullReset() {
    console.log("Starting raw SQLite database and filesystem reset...");
    
    try {
        // 1. Delete library folders from filesystem
        if (fs.existsSync(LIBRARY_ROOT)) {
            const items = fs.readdirSync(LIBRARY_ROOT);
            for (const item of items) {
                const itemPath = path.join(LIBRARY_ROOT, item);
                if (fs.statSync(itemPath).isDirectory()) {
                    console.log(`Deleting library folder: ${item}`);
                    fs.rmSync(itemPath, { recursive: true, force: true });
                }
            }
        }

        // 2. Disable foreign key checks
        sqlite.pragma("foreign_keys = OFF");
        
        // 3. Drop all tables
        const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
        for (const t of tables) {
            sqlite.exec(`DROP TABLE IF EXISTS "${t.name}"`);
            console.log(`Dropped table: ${t.name}`);
        }
        
        // 4. Drop all indexes
        const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
        for (const i of indexes) {
            sqlite.exec(`DROP INDEX IF EXISTS "${i.name}"`);
            console.log(`Dropped index: ${i.name}`);
        }
        
        console.log("Database and library folders reset successfully.");
        sqlite.pragma("foreign_keys = ON");
        
        console.log("\nNext step: Run 'npx drizzle-kit push' to recreate the schema.");
    } catch (err) {
        console.error("Error resetting database:", err);
    } finally {
        sqlite.close();
    }
}

fullReset();
