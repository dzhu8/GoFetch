import { NextRequest, NextResponse } from "next/server";
import folderRegistry from "@/server/folderRegistry";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// POST /api/folders/[name]/sync - Pull from remote for a specific folder
export async function POST(req: NextRequest, { params }: { params: { name: string } }) {
     try {
          const folderName = params.name;
          const folder = folderRegistry.getFolderByName(folderName);

          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          // Pull from remote
          const { stdout, stderr } = await execAsync("git pull origin HEAD", {
               cwd: folder.rootPath,
          });

          return NextResponse.json({
               message: "Successfully pulled from remote",
               output: stdout || stderr,
          });
     } catch (error) {
          console.error("Error pulling from remote:", error);
          return NextResponse.json(
               {
                    error: "Failed to pull from remote",
                    message: error instanceof Error ? error.message : "Unknown error",
               },
               { status: 500 }
          );
     }
}
