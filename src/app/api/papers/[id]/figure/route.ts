import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, extractedFigures } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/papers/[id]/figure — serve the first figure image from DB
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const paper = db.select({ firstFigurePath: papers.firstFigurePath }).from(papers).where(eq(papers.id, paperId)).get();
          if (!paper || !paper.firstFigurePath) {
               return NextResponse.json({ error: "Figure not found" }, { status: 404 });
          }

          const fig = db
               .select({ imageData: extractedFigures.imageData })
               .from(extractedFigures)
               .where(and(eq(extractedFigures.paperId, paperId), eq(extractedFigures.filename, paper.firstFigurePath)))
               .get();

          if (!fig || !fig.imageData) {
               return NextResponse.json({ error: "Figure file not found" }, { status: 404 });
          }

          const buffer = Buffer.isBuffer(fig.imageData)
               ? fig.imageData
               : Buffer.from(fig.imageData as ArrayBuffer);

          return new NextResponse(buffer, {
               headers: {
                    "Content-Type": "image/png",
                    "Content-Length": String(buffer.length),
                    "Cache-Control": "no-cache",
               },
          });
     } catch (error) {
          console.error("Error serving figure:", error);
          return NextResponse.json({ error: "Failed to serve figure" }, { status: 500 });
     }
}
