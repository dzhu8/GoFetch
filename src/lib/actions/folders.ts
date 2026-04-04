"use server";

import folderRegistry from "@/server/folderRegistry";
import { exec } from "child_process";
import { promisify } from "util";
import db from "@/server/db";
import { embeddings } from "@/server/db/schema";
import { count } from "drizzle-orm";

const execAsync = promisify(exec);

// GET /api/folders - Get all folders with optional GitHub sync data
export async function getFolders(includeGitData?: boolean) {
     try {
          const folders = folderRegistry.getFolders();

          // Fetch embedding counts
          const embeddingCounts = await db
               .select({
                    folderName: embeddings.folderName,
                    count: count(),
               })
               .from(embeddings)
               .groupBy(embeddings.folderName)
               .all();

          const countsMap = new Map(embeddingCounts.map((e) => [e.folderName, e.count]));

          const foldersWithCounts = folders.map((folder) => ({
               ...folder,
               embeddingCount: countsMap.get(folder.name) || 0,
          }));

          if (!includeGitData) {
               // Return basic folder information
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

          const folder = folderRegistry.addFolder(name, rootPath);

          return {
               message: "Folder added successfully",
               folder,
          };
     } catch (error) {
          console.error("Error adding folder:", error);
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
          const folder = folderRegistry.getFolderByName(folderName);

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

          const folder = folderRegistry.updateFolder(folderName, rootPath);

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
          folderRegistry.removeFolder(folderName);

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
          const folderName = name;
          const folder = folderRegistry.getFolderByName(folderName);

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
