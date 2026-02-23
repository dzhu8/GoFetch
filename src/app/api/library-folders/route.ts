import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { libraryFolders } from "@/server/db/schema";
import fs from "fs";
import path from "path";

/** Central directory where all GoFetch-managed library folders live */
export const LIBRARY_ROOT = path.join(process.cwd(), "data", "library");

function ensureLibraryRoot() {
     if (!fs.existsSync(LIBRARY_ROOT)) {
          fs.mkdirSync(LIBRARY_ROOT, { recursive: true });
     }
}

// GET /api/library-folders — list all library folders
export async function GET() {
     try {
          ensureLibraryRoot();
          const rows = db.select().from(libraryFolders).orderBy(libraryFolders.createdAt).all();
          return NextResponse.json({ folders: rows, libraryRoot: LIBRARY_ROOT });
     } catch (error) {
          console.error("Error fetching library folders:", error);
          return NextResponse.json({ error: "Failed to fetch library folders" }, { status: 500 });
     }
}

// POST /api/library-folders — create a new library folder
// rootPath is optional; if omitted, defaults to LIBRARY_ROOT/name
export async function POST(req: NextRequest) {
     try {
          ensureLibraryRoot();
          const body = await req.json();
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const rootPath = typeof body.rootPath === "string" ? body.rootPath.trim() : "";

          if (!name) {
               return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
          }

          const resolvedPath = rootPath || path.join(LIBRARY_ROOT, name);

          if (!fs.existsSync(resolvedPath)) {
               fs.mkdirSync(resolvedPath, { recursive: true });
          }

          const row = db
               .insert(libraryFolders)
               .values({ name, rootPath: resolvedPath })
               .returning()
               .get();

          return NextResponse.json({ folder: row }, { status: 201 });
     } catch (error: any) {
          console.error("Error creating library folder:", error);
          if (error?.message?.includes("UNIQUE constraint failed")) {
               return NextResponse.json({ error: "A folder with that name already exists" }, { status: 409 });
          }
          return NextResponse.json({ error: "Failed to create library folder" }, { status: 500 });
     }
}
