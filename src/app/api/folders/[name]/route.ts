import { NextRequest, NextResponse } from "next/server";
import folderRegistry from "@/server/folderRegistry";

type RouteContext = { params: Promise<{ name: string }> };

// GET /api/folders/[name] - Get a specific folder by name
export async function GET(req: NextRequest, context: RouteContext) {
     try {
          const { name: folderName } = await context.params;
          const folder = folderRegistry.getFolderByName(folderName);

          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          return NextResponse.json({ folder });
     } catch (error) {
          console.error("Error fetching folder:", error);
          return NextResponse.json({ error: "Failed to fetch folder" }, { status: 500 });
     }
}

// DELETE /api/folders/[name] - Delete a specific folder
export async function DELETE(req: NextRequest, context: RouteContext) {
     try {
          const { name: folderName } = await context.params;
          folderRegistry.removeFolder(folderName);

          return NextResponse.json({
               message: "Folder removed successfully",
          });
     } catch (error) {
          console.error("Error removing folder:", error);
          return NextResponse.json(
               {
                    error: "Failed to remove folder",
                    message: error instanceof Error ? error.message : "Unknown error",
               },
               { status: 500 }
          );
     }
}

// PUT /api/folders/[name] - Update a specific folder
export async function PUT(req: NextRequest, context: RouteContext) {
     try {
          const { name: folderName } = await context.params;
          const { rootPath } = await req.json();

          if (!rootPath) {
               return NextResponse.json({ error: "Root path is required" }, { status: 400 });
          }

          const folder = folderRegistry.updateFolder(folderName, rootPath);

          return NextResponse.json({
               message: "Folder updated successfully",
               folder,
          });
     } catch (error) {
          console.error("Error updating folder:", error);
          return NextResponse.json(
               {
                    error: "Failed to update folder",
                    message: error instanceof Error ? error.message : "Unknown error",
               },
               { status: 500 }
          );
     }
}
