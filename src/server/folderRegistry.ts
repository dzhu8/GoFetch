import fs from "fs";
import path from "path";

//@ts-ignore
export type FolderTree = Record<string, FolderTree | null>;

export interface FolderRegistration {
     name: string;
     rootPath: string;
     tree: FolderTree;
}

const IGNORED_DIRECTORY_NAMES = new Set([
     "node_modules",
     ".git",
     ".next",
     "dist",
     "build",
     "coverage",
     "__pycache__",
     ".turbo",
     ".vercel",
     ".cache",
]);

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

export class FolderRegistry {
     private folders: Map<string, FolderRegistration> = new Map();

     getFolders(): FolderRegistration[] {
          return Array.from(this.folders.values());
     }

     getFolderByName(name: string): FolderRegistration | undefined {
          return this.folders.get(name);
     }

     addFolder(name: string, rootPath: string): FolderRegistration {
          if (this.folders.has(name)) {
               throw new Error(`Folder with name ${name} already exists.`);
          }

          const absoluteRoot = path.resolve(rootPath);
          if (!this.isDirectory(absoluteRoot)) {
               throw new Error(`Path ${rootPath} is not a valid directory.`);
          }

          const registration = this.buildRegistration(name, rootPath);
          this.folders.set(name, registration);
          return registration;
     }

     isDirectory(dirPath: string): boolean {
          try {
               const stats = fs.statSync(dirPath);
               return stats.isDirectory();
          } catch {
               return false;
          }
     }

     updateFolder(name: string, rootPath: string): FolderRegistration {
          if (!this.folders.has(name)) {
               throw new Error(`Folder with name ${name} does not exist.`);
          }

          const registration = this.buildRegistration(name, rootPath);
          this.folders.set(name, registration);
          return registration;
     }

     removeFolder(name: string): void {
          this.folders.delete(name);
     }

     private buildRegistration(name: string, rootPath: string): FolderRegistration {
          const absoluteRoot = path.resolve(rootPath);
          this.assertDirectoryExists(absoluteRoot);

          const tree = this.buildFolderTree(absoluteRoot, absoluteRoot);
          return {
               name,
               rootPath: absoluteRoot,
               tree,
          };
     }

     private assertDirectoryExists(dirPath: string): void {
          const stats = fs.existsSync(dirPath) ? fs.statSync(dirPath) : null;
          if (!stats || !stats.isDirectory()) {
               throw new Error(`Folder path ${dirPath} does not exist or is not a directory.`);
          }
     }

     private buildFolderTree(currentPath: string, rootPath: string): FolderTree {
          const tree: FolderTree = {};
          const entries = fs.readdirSync(currentPath, { withFileTypes: true });

          for (const entry of entries) {
               if (this.shouldIgnore(entry, entry.name)) {
                    continue;
               }

               const fullPath = path.join(currentPath, entry.name);
               const relativePath = path.relative(rootPath, fullPath);

               if (relativePath.length === 0) {
                    continue;
               }

               if (entry.isDirectory()) {
                    tree[entry.name] = this.buildFolderTree(fullPath, rootPath);
               } else if (entry.isFile()) {
                    tree[entry.name] = null;
               }
          }

          return tree;
     }

     private shouldIgnore(entry: fs.Dirent, entryName: string): boolean {
          if (entry.isSymbolicLink()) {
               return true;
          }

          if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entryName)) {
               return true;
          }

          if (entry.isFile() && IGNORED_FILE_NAMES.has(entryName)) {
               return true;
          }

          return false;
     }
}

const folderRegistry = new FolderRegistry();

export default folderRegistry;
