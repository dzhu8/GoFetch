import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, libraryFolders, paperChunks, paperFolderLinks } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import fs from "fs";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/papers/[id] — get a single paper
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper) {
               return NextResponse.json({ error: "Paper not found" }, { status: 404 });
          }

          return NextResponse.json({ paper });
     } catch (error) {
          console.error("Error fetching paper:", error);
          return NextResponse.json({ error: "Failed to fetch paper" }, { status: 500 });
     }
}

// DELETE /api/papers/[id]?folderId=N — remove paper from a specific folder, or delete entirely
//
// With ?folderId=N:
//   - If this is a secondary-link folder: remove only the paperFolderLinks entry.
//   - If this is the canonical folder and the paper has other folder associations:
//       re-home the paper to the first secondary folder and remove that link.
//   - If this is the last association: delete the paper record, file, and all chunks.
// Without ?folderId: delete the paper record and file unconditionally (admin use).
export async function DELETE(req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper) {
               return NextResponse.json({ error: "Paper not found" }, { status: 404 });
          }

          const folderIdParam = req.nextUrl.searchParams.get("folderId");
          const targetFolderId = folderIdParam ? parseInt(folderIdParam, 10) : null;

          if (targetFolderId !== null && !isNaN(targetFolderId)) {
               const isCanonicalFolder = paper.folderId === targetFolderId;
               const secondaryLinks = db
                    .select()
                    .from(paperFolderLinks)
                    .where(eq(paperFolderLinks.paperId, paperId))
                    .all();

               if (!isCanonicalFolder) {
                    // Secondary-link removal — just delete the link
                    db.delete(paperFolderLinks)
                         .where(
                              and(
                                   eq(paperFolderLinks.paperId, paperId),
                                   eq(paperFolderLinks.folderId, targetFolderId),
                              ),
                         )
                         .run();
                    return NextResponse.json({ message: "Paper removed from folder." });
               }

               // Removing from canonical folder
               if (secondaryLinks.length > 0) {
                    // Re-home: promote first secondary link to canonical
                    const newHome = secondaryLinks[0];
                    db.update(papers)
                         .set({ folderId: newHome.folderId, updatedAt: new Date().toISOString() })
                         .where(eq(papers.id, paperId))
                         .run();
                    db.delete(paperFolderLinks)
                         .where(
                              and(
                                   eq(paperFolderLinks.paperId, paperId),
                                   eq(paperFolderLinks.folderId, newHome.folderId),
                              ),
                         )
                         .run();
                    return NextResponse.json({ message: "Paper removed from folder." });
               }
               // No other associations — fall through to full delete below
          }

          // Full delete: remove file, figure, chunks, and record
          if (fs.existsSync(paper.filePath)) {
               fs.unlinkSync(paper.filePath);
          }

          if (paper.firstFigurePath) {
               const folder = db
                    .select()
                    .from(libraryFolders)
                    .where(eq(libraryFolders.id, paper.folderId))
                    .get();
               if (folder) {
                    const figPath = require("path").join(folder.rootPath, paper.firstFigurePath);
                    if (fs.existsSync(figPath)) {
                         fs.unlinkSync(figPath);
                    }
               }
          }

          db.delete(paperChunks).where(eq(paperChunks.paperId, paperId)).run();
          db.delete(papers).where(eq(papers.id, paperId)).run();

          return NextResponse.json({ message: "Paper deleted successfully" });
     } catch (error) {
          console.error("Error deleting paper:", error);
          return NextResponse.json({ error: "Failed to delete paper" }, { status: 500 });
     }
}
