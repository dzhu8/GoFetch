import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { libraryFolders, papers } from "@/server/db/schema";
import { eq } from "drizzle-orm";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/library-folders/[id] — get a single library folder
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const folderId = parseInt(id, 10);
          if (isNaN(folderId)) {
               return NextResponse.json({ error: "Invalid folder ID" }, { status: 400 });
          }

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          return NextResponse.json({ folder });
     } catch (error) {
          console.error("Error fetching library folder:", error);
          return NextResponse.json({ error: "Failed to fetch library folder" }, { status: 500 });
     }
}

// DELETE /api/library-folders/[id] — delete a library folder and all its papers (cascade)
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const folderId = parseInt(id, 10);
          if (isNaN(folderId)) {
               return NextResponse.json({ error: "Invalid folder ID" }, { status: 400 });
          }

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          // Delete folder (papers cascade via FK)
          db.delete(libraryFolders).where(eq(libraryFolders.id, folderId)).run();

          return NextResponse.json({ message: "Folder deleted successfully" });
     } catch (error) {
          console.error("Error deleting library folder:", error);
          return NextResponse.json({ error: "Failed to delete library folder" }, { status: 500 });
     }
}
