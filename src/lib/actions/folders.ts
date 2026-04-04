"use server";

import { exec } from "child_process";
import { promisify } from "util";
import { count, eq, isNotNull } from "drizzle-orm";

import db from "@/server/db";
import { libraryFolders, papers, paperChunks } from "@/server/db/schema";

const execAsync = promisify(exec);

// GET /api/folders - Get all folders with optional GitHub sync data
export async function getFolders(includeGitData?: boolean) {
     try {
          const rows = db.select().from(libraryFolders).orderBy(libraryFolders.createdAt).all();

          // Fetch embedding counts per folder (count paper chunks with non-null embeddings)
          const embeddingCounts = db
               .select({
                    folderId: papers.folderId,
                    count: count(),
               })
               .from(paperChunks)
               .innerJoin(papers, eq(paperChunks.paperId, papers.id))
               .where(isNotNull(paperChunks.embedding))
               .groupBy(papers.folderId)
               .all();

          const countsMap = new Map(embeddingCounts.map((e) => [e.folderId, e.count]));

          // Check git connectivity for each folder
          const foldersWithCounts = await Promise.all(
               rows.map(async (folder) => {
                    let githubUrl: string | null = null;
                    let isGitConnected = false;

                    try {
                         const { stdout } = await execAsync("git remote get-url origin", {
                              cwd: folder.rootPath,
                         });
                         const url = stdout.trim();
                         if (url) {
                              isGitConnected = true;
                              githubUrl = url;
                         }
                    } catch {
                         // Not a git repo or no remote
                    }

                    return {
                         name: folder.name,
                         rootPath: folder.rootPath,
                         updatedAt: folder.updatedAt,
                         githubUrl,
                         isGitConnected,
                         embeddingCount: countsMap.get(folder.id) ?? 0,
                    };
               })
          );

          if (!includeGitData) {
               return { folders: foldersWithCounts };
          }

          // Include GitHub sync data
          const foldersWithGitData = await Promise.all(
               foldersWithCounts.map(async (folder) => {
                    if (!folder.isGitConnected) {
                         return {
                              ...folder,
                              filesChanged: 0,
                              filesAdded: 0,
                              filesDeleted: 0,
                              linesAdded: 0,
                              linesDeleted: 0,
                         };
                    }

                    try {
                         // Fetch from remote to get latest changes
                         await execAsync("git fetch origin", { cwd: folder.rootPath });

                         // Get diff stats between local and remote
                         const { stdout: diffStats } = await execAsync("git diff --shortstat HEAD origin/HEAD", {
                              cwd: folder.rootPath,
                         });

                         // Parse diff stats (format: " 5 files changed, 120 insertions(+), 45 deletions(-)")
                         let filesChanged = 0;
                         let linesAdded = 0;
                         let linesDeleted = 0;

                         const fileMatch = diffStats.match(/(\d+)\s+file/);
                         const insertMatch = diffStats.match(/(\d+)\s+insertion/);
                         const deleteMatch = diffStats.match(/(\d+)\s+deletion/);

                         if (fileMatch) filesChanged = parseInt(fileMatch[1]);
                         if (insertMatch) linesAdded = parseInt(insertMatch[1]);
                         if (deleteMatch) linesDeleted = parseInt(deleteMatch[1]);

                         // Get files added and deleted
                         const { stdout: diffNameStatus } = await execAsync("git diff --name-status HEAD origin/HEAD", {
                              cwd: folder.rootPath,
                         });

                         let filesAdded = 0;
                         let filesDeleted = 0;

                         diffNameStatus.split("\n").forEach((line) => {
                              if (line.startsWith("A\t")) filesAdded++;
                              if (line.startsWith("D\t")) filesDeleted++;
                         });

                         return {
                              ...folder,
                              filesChanged,
                              filesAdded,
                              filesDeleted,
                              linesAdded,
                              linesDeleted,
                         };
                    } catch (error) {
                         // If git commands fail, return folder without git data
                         console.error(`Error getting git data for ${folder.name}:`, error);
                         return {
                              ...folder,
                              filesChanged: 0,
                              filesAdded: 0,
                              filesDeleted: 0,
                              linesAdded: 0,
                              linesDeleted: 0,
                         };
                    }
               })
          );

          return { folders: foldersWithGitData };
     } catch (error) {
          console.error("Error fetching folders:", error);
          return { error: "Failed to fetch folders" };
     }
}

// POST /api/folders - Add a new folder
export async function addFolder(name: string, rootPath: string) {
     try {
          if (!name || !rootPath) {
               return { error: "Folder name and path are required" };
          }

          const row = db
               .insert(libraryFolders)
               .values({ name: name.trim(), rootPath: rootPath.trim() })
               .returning()
               .get();

          return {
               message: "Folder added successfully",
               folder: row,
          };
     } catch (error: any) {
          console.error("Error adding folder:", error);
          if (error?.message?.includes("UNIQUE constraint failed")) {
               return { error: "A folder with that name already exists", message: "A folder with that name already exists" };
          }
          return {
               error: "Failed to add folder",
               message: error instanceof Error ? error.message : "Unknown error",
          };
     }
}

// GET /api/folders/[name] - Get a specific folder by name
export async function getFolder(name: string) {
     try {
          const folderName = decodeURIComponent(name);
          const folder = db
               .select()
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();

          if (!folder) {
               return { error: "Folder not found" };
          }

          return { folder };
     } catch (error) {
          console.error("Error fetching folder:", error);
          return { error: "Failed to fetch folder" };
     }
}

// PUT /api/folders/[name] - Update a specific folder
export async function updateFolder(name: string, rootPath: string) {
     try {
          const folderName = decodeURIComponent(name);

          if (!rootPath) {
               return { error: "Root path is required" };
          }

          const existing = db
               .select()
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();

          if (!existing) {
               return { error: "Folder not found", message: "Folder not found" };
          }

          db.update(libraryFolders)
               .set({ rootPath, updatedAt: new Date().toISOString() })
               .where(eq(libraryFolders.id, existing.id))
               .run();

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, existing.id)).get();

          return {
               message: "Folder updated successfully",
               folder,
          };
     } catch (error) {
          console.error("Error updating folder:", error);
          return {
               error: "Failed to update folder",
               message: error instanceof Error ? error.message : "Unknown error",
          };
     }
}

// DELETE /api/folders/[name] - Delete a specific folder
export async function deleteFolder(name: string) {
     try {
          const folderName = decodeURIComponent(name);

          const existing = db
               .select({ id: libraryFolders.id })
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();

          if (!existing) {
               return { error: "Folder not found", message: "Folder not found" };
          }

          // Delete folder (papers cascade via FK)
          db.delete(libraryFolders).where(eq(libraryFolders.id, existing.id)).run();

          return {
               message: "Folder removed successfully",
          };
     } catch (error) {
          console.error("Error removing folder:", error);
          return {
               error: "Failed to remove folder",
               message: error instanceof Error ? error.message : "Unknown error",
          };
     }
}

// POST /api/folders/[name]/sync - Pull from remote for a specific folder
export async function syncFolder(name: string) {
     try {
          const folder = db
               .select()
               .from(libraryFolders)
               .where(eq(libraryFolders.name, name))
               .get();

          if (!folder) {
               return { error: "Folder not found" };
          }

          // Pull from remote
          const { stdout, stderr } = await execAsync("git pull origin HEAD", {
               cwd: folder.rootPath,
          });

          return {
               message: "Successfully pulled from remote",
               output: stdout || stderr,
          };
     } catch (error) {
          console.error("Error pulling from remote:", error);
          return {
               error: "Failed to pull from remote",
               message: error instanceof Error ? error.message : "Unknown error",
          };
     }
}
