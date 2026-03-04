import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { activeProcs } from "../processRegistry";

function tryUnlink(filePath: string | null | undefined) {
     if (!filePath) return;
     try {
          fs.rmSync(filePath, { force: true });
     } catch {
          // Best-effort
     }
}

export async function DELETE(
     _req: NextRequest,
     { params }: { params: Promise<{ id: string }> },
) {
     const { id: idStr } = await params;
     const paperId = parseInt(idStr, 10);
     if (isNaN(paperId)) {
          return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
     }

     // Kill the child process if it is still running
     const entry = activeProcs.get(paperId);
     if (entry) {
          try {
               entry.proc.kill("SIGTERM");
          } catch {
               // Process may have already exited — ignore
          }
          activeProcs.delete(paperId);

          // Clean up the OCR temp directory
          try {
               fs.rmSync(entry.tempDir, { recursive: true, force: true });
          } catch {
               // Best-effort cleanup
          }
     }

     // Fetch the paper record so we know which library files to remove
     let paperRow: typeof papers.$inferSelect | undefined;
     try {
          paperRow = db.select().from(papers).where(eq(papers.id, paperId)).get();
     } catch {
          // Record may not exist yet if cancellation raced with insertion
     }

     if (paperRow) {
          // Delete the PDF from the library folder
          tryUnlink(paperRow.filePath);

          // Delete the OCR JSON sidecar (e.g. paper.pdf → paper.ocr.json)
          const ocrJsonPath = paperRow.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          tryUnlink(ocrJsonPath);

          // Delete the extracted first figure image if present
          tryUnlink(paperRow.firstFigurePath);

          // Remove the DB record entirely
          try {
               db.delete(papers).where(eq(papers.id, paperId)).run();
          } catch {
               // Best-effort
          }
     }

     return NextResponse.json({ cancelled: true });
}
