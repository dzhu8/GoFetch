import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const discoverDataDir = (): string => {
     const candidates = new Set<string>();
     if (process.env.DATA_DIR) {
          candidates.add(process.env.DATA_DIR);
     }

     const cwd = process.cwd();
     candidates.add(cwd);
     candidates.add(path.resolve(cwd, ".."));
     candidates.add(path.resolve(cwd, "../.."));

     for (const candidate of candidates) {
          const dbPath = path.join(candidate, "data", "db.sqlite");
          if (fs.existsSync(dbPath)) {
               return candidate;
          }
     }

     return process.env.DATA_DIR || cwd;
};

const DATA_DIR = discoverDataDir();
const DB_PATH = path.join(DATA_DIR, "data", "db.sqlite");

let cachedDb: Database.Database | null = null;

const getDatabase = () => {
     if (!fs.existsSync(DB_PATH)) {
          return null;
     }

     if (!cachedDb) {
          cachedDb = new Database(DB_PATH, { readonly: true });
     }

     return cachedDb;
};

export type StoredFolder = {
     name: string;
     rootPath: string;
     githubUrl: string | null;
};

export const findFolderByPath = (folderPath: string): StoredFolder | null => {
     try {
          const db = getDatabase();
          if (!db) {
               return null;
          }

          const statement = db.prepare(
               "SELECT name, root_path as rootPath, github_url as githubUrl FROM folders WHERE root_path = ? LIMIT 1"
          );
          const result = statement.get(folderPath) as StoredFolder | undefined;
          return result ?? null;
     } catch (error) {
          console.warn("[gofetch-cli] Unable to read folders table:", error);
          return null;
     }
};
