import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, libraryFolders, paperChunks } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import { processPaperOCR, queuePaperEmbedding } from "@/lib/embed/paperProcess";

async function triggerPendingEmbeddings(folderId: number, folderName: string): Promise<boolean> {
     const papersToEmbed = db
          .select({ id: papers.id, fileName: papers.fileName, filePath: papers.filePath })
          .from(papers)
          .where(eq(papers.folderId, folderId))
          .all()
          .filter((p) => {
               const hasChunks = db
                    .select()
                    .from(paperChunks)
                    .where(eq(paperChunks.paperId, p.id))
                    .limit(1)
                    .get();
               return !hasChunks;
          });

     let triggered = false;
     for (const paper of papersToEmbed) {
          const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          if (fs.existsSync(ocrPath)) {
               try {
                    await processPaperOCR(paper.id, ocrPath);
                    queuePaperEmbedding(paper.id, folderName);
                    triggered = true;
               } catch (err) {
                    console.warn(`[Library] Failed to process pending embedding for ${paper.fileName}:`, err);
               }
          }
     }
     return triggered;
}

// GET /api/papers?folderId=123 — list papers in a folder
export async function GET(req: NextRequest) {
     try {
          const folderIdParam = req.nextUrl.searchParams.get("folderId");
          if (!folderIdParam) {
               return NextResponse.json({ error: "folderId is required" }, { status: 400 });
          }

          const folderId = parseInt(folderIdParam, 10);
          const rows = db
               .select()
               .from(papers)
               .where(eq(papers.folderId, folderId))
               .orderBy(papers.createdAt)
               .all();

          // Also trigger background embedding check for this specific folder
          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          let embeddingTriggered = false;
          if (folder) {
               embeddingTriggered = await triggerPendingEmbeddings(folder.id, folder.name).catch((e) => {
                    console.error(e);
                    return false;
               });
          }

          return NextResponse.json({ papers: rows, embeddingTriggered, folderName: folder?.name ?? null });
     } catch (error) {
          console.error("Error fetching papers:", error);
          return NextResponse.json({ error: "Failed to fetch papers" }, { status: 500 });
     }
}
