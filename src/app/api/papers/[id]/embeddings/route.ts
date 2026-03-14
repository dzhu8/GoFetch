import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { paperChunks, papers, libraryFolders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { processPaperOCR, queuePaperEmbedding } from "@/lib/embed/paperProcess";
import fs from "fs";

type RouteParams = { params: Promise<{ id: string }> };

// DELETE /api/papers/[id]/embeddings — delete embeddings for a paper
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          // Simply set embedding to null for all chunks of this paper
          db.update(paperChunks)
               .set({ embedding: null })
               .where(eq(paperChunks.paperId, paperId))
               .run();

          return NextResponse.json({ message: "Embeddings deleted successfully" });
     } catch (error) {
          console.error("Error deleting embeddings:", error);
          return NextResponse.json({ error: "Failed to delete embeddings" }, { status: 500 });
     }
}

// POST /api/papers/[id]/embeddings — recompute embeddings for a paper
export async function POST(_req: NextRequest, { params }: RouteParams) {
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

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, paper.folderId)).get();
          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          if (!fs.existsSync(ocrPath)) {
               return NextResponse.json({ error: "OCR result not found. Please wait for processing." }, { status: 400 });
          }

          // Re-process chunks from OCR if they were somehow lost or need refresh
          await processPaperOCR(paper.id, ocrPath);
          
          // Queue the actual embedding process
          queuePaperEmbedding(paper.id, folder.name, paper.fileName);

          return NextResponse.json({ message: "Embedding process queued" });
     } catch (error) {
          console.error("Error recomputing embeddings:", error);
          return NextResponse.json({ error: "Failed to recompute embeddings" }, { status: 500 });
     }
}
