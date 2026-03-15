import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { libraryFolders, papers } from "@/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/cli/library
 *   → Returns all library folders.
 *
 * GET /api/cli/library?folderName=<name>
 *   → Returns metadata for the named folder and the list of papers it contains.
 *
 * GET /api/cli/library?folderId=<id>
 *   → Same as above but resolved by numeric folder id.
 */
export async function GET(req: NextRequest) {
     const folderName = req.nextUrl.searchParams.get("folderName");
     const folderIdParam = req.nextUrl.searchParams.get("folderId");

     // ── No filter: list all folders ───────────────────────────────────────
     if (!folderName && !folderIdParam) {
          const folders = db
               .select({
                    id: libraryFolders.id,
                    name: libraryFolders.name,
                    rootPath: libraryFolders.rootPath,
                    createdAt: libraryFolders.createdAt,
               })
               .from(libraryFolders)
               .orderBy(libraryFolders.name)
               .all();

          return NextResponse.json({ folders });
     }

     // ── Resolve the target folder ─────────────────────────────────────────
     let folder: { id: number; name: string; rootPath: string; createdAt: string } | undefined;

     if (folderIdParam) {
          const folderId = parseInt(folderIdParam, 10);
          if (isNaN(folderId)) {
               return NextResponse.json({ error: "Invalid folderId" }, { status: 400 });
          }
          folder = db
               .select({
                    id: libraryFolders.id,
                    name: libraryFolders.name,
                    rootPath: libraryFolders.rootPath,
                    createdAt: libraryFolders.createdAt,
               })
               .from(libraryFolders)
               .where(eq(libraryFolders.id, folderId))
               .get();
     } else if (folderName) {
          folder = db
               .select({
                    id: libraryFolders.id,
                    name: libraryFolders.name,
                    rootPath: libraryFolders.rootPath,
                    createdAt: libraryFolders.createdAt,
               })
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();
     }

     if (!folder) {
          return NextResponse.json(
               { error: folderName ? `Folder "${folderName}" not found` : "Folder not found" },
               { status: 404 },
          );
     }

     // ── List papers in the folder ─────────────────────────────────────────
     const paperList = db
          .select({
               id: papers.id,
               fileName: papers.fileName,
               title: papers.title,
               doi: papers.doi,
               status: papers.status,
               createdAt: papers.createdAt,
          })
          .from(papers)
          .where(eq(papers.folderId, folder.id))
          .orderBy(papers.fileName)
          .all();

     return NextResponse.json({
          folder,
          papers: paperList,
     });
}
