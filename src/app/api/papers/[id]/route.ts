import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, libraryFolders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
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

// DELETE /api/papers/[id] — delete paper and its file
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
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

          // Delete the PDF file
          if (fs.existsSync(paper.filePath)) {
               fs.unlinkSync(paper.filePath);
          }

          // Delete the figure file if it exists
          if (paper.firstFigurePath) {
               const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, paper.folderId)).get();
               if (folder) {
                    const figPath = require("path").join(folder.rootPath, paper.firstFigurePath);
                    if (fs.existsSync(figPath)) {
                         fs.unlinkSync(figPath);
                    }
               }
          }

          // Delete from database
          db.delete(papers).where(eq(papers.id, paperId)).run();

          return NextResponse.json({ message: "Paper deleted successfully" });
     } catch (error) {
          console.error("Error deleting paper:", error);
          return NextResponse.json({ error: "Failed to delete paper" }, { status: 500 });
     }
}
