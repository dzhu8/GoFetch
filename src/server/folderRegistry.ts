import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import db from "@/server/db";
import { folders as foldersTable, embeddings } from "@/server/db/schema";
import { IGNORED_DIRECTORY_NAMES, IGNORED_FILE_NAMES } from "./folderIgnore";
import { cancelInitialEmbedding, ensureFolderPrimed, scheduleInitialEmbedding } from "@/lib/embed/initial";
import folderEvents from "./folderEvents";

//@ts-ignore
export type FolderTree = Record<string, FolderTree | null>;

export interface FolderRegistration {
     name: string;
     rootPath: string;
     tree: FolderTree;
     githubUrl: string | null;
     isGitConnected: boolean;
     updatedAt?: string;
}

export class FolderRegistry {
     private folders: Map<string, FolderRegistration> = new Map();

     constructor() {
          this.loadPersistedFolders();
     }

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

          const metadata = this.persistFolderRecord(name, absoluteRoot);
          const registration = this.buildRegistration(name, absoluteRoot, metadata);
          this.folders.set(name, registration);
          scheduleInitialEmbedding(registration);
          folderEvents.notifyChange();
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

          const absoluteRoot = path.resolve(rootPath);
          if (!this.isDirectory(absoluteRoot)) {
               throw new Error(`Path ${rootPath} is not a valid directory.`);
          }
          const metadata = this.persistFolderRecord(name, absoluteRoot);
          const registration = this.buildRegistration(name, absoluteRoot, metadata);
          this.folders.set(name, registration);
          folderEvents.notifyChange();
          return registration;
     }

     removeFolder(name: string): void {
          const registration = this.folders.get(name);

          // Stop background work before touching persistence to avoid FK violations from late callbacks.
          cancelInitialEmbedding(name);

          if (registration) {
               this.folders.delete(name);
          }

          // Clean up embeddings for this folder.
          this.cleanupFolderData(name);

          this.deleteFolderRecord(name);
          folderEvents.notifyChange();
     }

     private cleanupFolderData(folderName: string): void {
          try {
               // Delete embeddings for this folder
               db.delete(embeddings).where(eq(embeddings.folderName, folderName)).run();
          } catch (error) {
               console.error(`[folderRegistry] Failed to clean up data for ${folderName}:`, error);
          }
     }

     private buildRegistration(
          name: string,
          rootPath: string,
          metadata?: Partial<Pick<FolderRegistration, "githubUrl" | "isGitConnected" | "updatedAt">>
     ): FolderRegistration {
          const absoluteRoot = path.resolve(rootPath);
          this.assertDirectoryExists(absoluteRoot);

          const tree = this.buildFolderTree(absoluteRoot, absoluteRoot);
          return {
               name,
               rootPath: absoluteRoot,
               tree,
               githubUrl: metadata?.githubUrl ?? null,
               isGitConnected: metadata?.isGitConnected ?? false,
               updatedAt: metadata?.updatedAt,
          };
     }

     private loadPersistedFolders(): void {
          try {
               const records = db
                    .select({
                         name: foldersTable.name,
                         rootPath: foldersTable.rootPath,
                         githubUrl: foldersTable.githubUrl,
                         isGitConnected: foldersTable.isGitConnected,
                         updatedAt: foldersTable.updatedAt,
                    })
                    .from(foldersTable)
                    .all();

               for (const record of records) {
                    try {
                         const registration = this.buildRegistration(record.name, record.rootPath, {
                              githubUrl: record.githubUrl,
                              isGitConnected: Boolean(record.isGitConnected),
                              updatedAt: record.updatedAt,
                         });
                         this.folders.set(record.name, registration);
                         ensureFolderPrimed(registration).catch((error) => {
                              console.error(`[folderRegistry] Failed prime for ${record.name}:`, error);
                         });
                    } catch (error) {
                         console.error(`[folderRegistry] Skipping persisted folder ${record.name}:`, error);
                    }
               }
          } catch (error) {
               const message = error instanceof Error ? error.message : String(error);
               if (/no such table/i.test(message)) {
                    console.warn(
                         "[folderRegistry] folders table not found. Run database migrations to persist registered folders."
                    );
                    return;
               }
               console.error("[folderRegistry] Failed to load persisted folders:", error);
          }
     }

     private persistFolderRecord(
          name: string,
          rootPath: string
     ): Pick<FolderRegistration, "githubUrl" | "isGitConnected" | "updatedAt"> {
          const metadata = this.computeGitMetadata(rootPath);
          const now = new Date().toISOString();

          try {
               const existing = db
                    .select({ id: foldersTable.id })
                    .from(foldersTable)
                    .where(eq(foldersTable.name, name))
                    .get();

               if (existing) {
                    db.update(foldersTable)
                         .set({
                              rootPath,
                              githubUrl: metadata.githubUrl,
                              isGitConnected: metadata.isGitConnected,
                              updatedAt: now,
                         })
                         .where(eq(foldersTable.id, existing.id))
                         .run();
               } else {
                    db.insert(foldersTable)
                         .values({
                              name,
                              rootPath,
                              githubUrl: metadata.githubUrl,
                              isGitConnected: metadata.isGitConnected,
                              createdAt: now,
                              updatedAt: now,
                         })
                         .run();
               }
          } catch (error) {
               const message = error instanceof Error ? error.message : String(error);
               if (/no such table/i.test(message)) {
                    throw new Error(
                         "Folders table does not exist. Run database migrations (yarn db:migrate) to enable persistence."
                    );
               }
               if (/UNIQUE constraint failed: folders.root_path/i.test(message)) {
                    throw new Error(`Path ${rootPath} has already been registered under a different name.`);
               }
               throw error instanceof Error ? error : new Error(message);
          }

          return {
               ...metadata,
               updatedAt: now,
          };
     }

     private deleteFolderRecord(name: string): void {
          try {
               db.delete(foldersTable).where(eq(foldersTable.name, name)).run();
          } catch (error) {
               const message = error instanceof Error ? error.message : String(error);
               if (/no such table/i.test(message)) {
                    return;
               }
               throw error instanceof Error ? error : new Error(message);
          }
     }

     private computeGitMetadata(rootPath: string): Pick<FolderRegistration, "githubUrl" | "isGitConnected"> {
          try {
               const remote = execSync("git config --get remote.origin.url", {
                    cwd: rootPath,
                    stdio: ["ignore", "pipe", "ignore"],
               })
                    .toString()
                    .trim();

               if (!remote) {
                    return { githubUrl: null, isGitConnected: false };
               }

               const githubUrl = this.normalizeGithubRemote(remote);
               return {
                    githubUrl,
                    isGitConnected: true,
               };
          } catch {
               return { githubUrl: null, isGitConnected: false };
          }
     }

     private normalizeGithubRemote(remote: string): string | null {
          if (!remote) {
               return null;
          }

          let url = remote.trim();
          if (!url) {
               return null;
          }

          if (url.startsWith("git@github.com:")) {
               url = url.replace("git@github.com:", "https://github.com/");
          } else if (url.startsWith("ssh://git@github.com/")) {
               url = url.replace("ssh://git@github.com/", "https://github.com/");
          }

          if (url.endsWith(".git")) {
               url = url.slice(0, -4);
          }

          return url.includes("github.com") ? url : null;
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
