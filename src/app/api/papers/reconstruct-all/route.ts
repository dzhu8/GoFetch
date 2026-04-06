import { NextResponse } from "next/server";
import db from "@/server/db";
import { papers, paperSections, libraryFolders } from "@/server/db/schema";
import { eq, sql } from "drizzle-orm";
import { queuePaperReconstruction } from "@/lib/embed/paperProcess";
import fs from "fs";

/**
 * POST /api/papers/reconstruct-all
 * Bulk backfill: queue reconstruction for all papers that have OCR JSON on disk
 * but no paperSections rows yet.
 */
export async function POST() {
     // Find papers that have no paperSections rows
     const allPapers = db
          .select({
               id: papers.id,
               fileName: papers.fileName,
               filePath: papers.filePath,
               folderId: papers.folderId,
          })
          .from(papers)
          .where(eq(papers.status, "ready"))
          .all();

     // Get folder names for queueing
     const folders = db.select({ id: libraryFolders.id, name: libraryFolders.name }).from(libraryFolders).all();
     const folderNameMap = new Map(folders.map((f) => [f.id, f.name]));

     // Check which papers already have sections
     const papersWithSections = new Set(
          db
               .select({ paperId: paperSections.paperId })
               .from(paperSections)
               .groupBy(paperSections.paperId)
               .all()
               .map((r) => r.paperId)
     );

     let queued = 0;
     let skippedNoOcr = 0;
     let skippedHasSections = 0;

     for (const paper of allPapers) {
          if (papersWithSections.has(paper.id)) {
               skippedHasSections++;
               continue;
          }

          // Check for OCR JSON file on disk
          const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          if (!fs.existsSync(ocrPath)) {
               skippedNoOcr++;
               continue;
          }

          const folderName = folderNameMap.get(paper.folderId) ?? "unknown";
          queuePaperReconstruction(paper.id, folderName, paper.fileName, ocrPath, paper.filePath);
          queued++;
     }

     return NextResponse.json({
          queued,
          skippedHasSections,
          skippedNoOcr,
          total: allPapers.length,
     });
}
