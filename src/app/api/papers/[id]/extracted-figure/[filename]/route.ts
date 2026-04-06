import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, libraryFolders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

type RouteParams = { params: Promise<{ id: string; filename: string }> };

// GET /api/papers/[id]/extracted-figure/[filename] — serve an extracted figure PNG
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id, filename } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          // Sanitize filename to prevent path traversal
          const safeName = path.basename(filename);
          if (safeName !== filename) {
               return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper || !paper.filePath) {
               return NextResponse.json({ error: "Paper not found" }, { status: 404 });
          }

          // Extracted figures are stored alongside the PDF
          const pdfDir = path.dirname(paper.filePath);
          const figPath = path.join(pdfDir, safeName);

          if (!fs.existsSync(figPath)) {
               return NextResponse.json({ error: "Extracted figure not found" }, { status: 404 });
          }

          const fileBuffer = fs.readFileSync(figPath);
          return new NextResponse(fileBuffer, {
               headers: {
                    "Content-Type": "image/png",
                    "Content-Length": String(fileBuffer.length),
                    "Cache-Control": "public, max-age=86400",
               },
          });
     } catch (error) {
          console.error("Error serving extracted figure:", error);
          return NextResponse.json({ error: "Failed to serve figure" }, { status: 500 });
     }
}
