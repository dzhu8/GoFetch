import { NextRequest, NextResponse } from "next/server";
import folderRegistry from "@/server/folderRegistry";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

// GET /api/folders - Get all folders with optional GitHub sync data
export async function GET(req: NextRequest) {
     try {
          const searchParams = req.nextUrl.searchParams;
          const includeGitData = searchParams.get("includeGitData") === "true";

          const folders = folderRegistry.getFolders();

          if (!includeGitData) {
               // Return basic folder information
               return NextResponse.json({ folders });
          }

          // Include GitHub sync data
          const foldersWithGitData = await Promise.all(
               folders.map(async (folder) => {
                    try {
                         // Check if folder is a git repository
                         const { stdout: remoteUrl } = await execAsync("git config --get remote.origin.url", {
                              cwd: folder.rootPath,
                         });

                         // Get GitHub URL
                         let githubUrl = remoteUrl.trim();
                         if (githubUrl.startsWith("git@github.com:")) {
                              githubUrl = githubUrl.replace("git@github.com:", "https://github.com/");
                         }
                         if (githubUrl.endsWith(".git")) {
                              githubUrl = githubUrl.slice(0, -4);
                         }

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
                              githubUrl,
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
                              githubUrl: null,
                              filesChanged: 0,
                              filesAdded: 0,
                              filesDeleted: 0,
                              linesAdded: 0,
                              linesDeleted: 0,
                         };
                    }
               })
          );

          return NextResponse.json({ folders: foldersWithGitData });
     } catch (error) {
          console.error("Error fetching folders:", error);
          return NextResponse.json({ error: "Failed to fetch folders" }, { status: 500 });
     }
}

// POST /api/folders - Add a new folder
export async function POST(req: NextRequest) {
     try {
          const { name, rootPath } = await req.json();

          if (!name || !rootPath) {
               return NextResponse.json({ error: "Folder name and path are required" }, { status: 400 });
          }

          const folder = folderRegistry.addFolder(name, rootPath);

          return NextResponse.json(
               {
                    message: "Folder added successfully",
                    folder,
               },
               { status: 201 }
          );
     } catch (error) {
          console.error("Error adding folder:", error);
          return NextResponse.json(
               {
                    error: "Failed to add folder",
                    message: error instanceof Error ? error.message : "Unknown error",
               },
               { status: 500 }
          );
     }
}
