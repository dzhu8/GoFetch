import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/papers/[id]/pdf — serve the PDF file
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

          if (!fs.existsSync(paper.filePath)) {
               return NextResponse.json({ error: "PDF file not found on disk" }, { status: 404 });
          }

          const fileBuffer = fs.readFileSync(paper.filePath);

          return new NextResponse(fileBuffer, {
               headers: {
                    "Content-Type": "application/pdf",
                    "Content-Disposition": `inline; filename="${paper.fileName}"`,
                    "Content-Length": String(fileBuffer.length),
               },
          });
     } catch (error) {
          console.error("Error serving PDF:", error);
          return NextResponse.json({ error: "Failed to serve PDF" }, { status: 500 });
     }
}
