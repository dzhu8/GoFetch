import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { extractedFigures } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

type RouteParams = { params: Promise<{ id: string; filename: string }> };

// GET /api/papers/[id]/extracted-figure/[filename] — serve an extracted figure PNG from DB
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id, filename } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const fig = db
               .select({ imageData: extractedFigures.imageData })
               .from(extractedFigures)
               .where(and(eq(extractedFigures.paperId, paperId), eq(extractedFigures.filename, filename)))
               .get();

          if (!fig || !fig.imageData) {
               return NextResponse.json({ error: "Extracted figure not found" }, { status: 404 });
          }

          const buffer = Buffer.isBuffer(fig.imageData)
               ? fig.imageData
               : Buffer.from(fig.imageData as ArrayBuffer);

          return new NextResponse(buffer, {
               headers: {
                    "Content-Type": "image/png",
                    "Content-Length": String(buffer.length),
                    "Cache-Control": "public, max-age=86400",
               },
          });
     } catch (error) {
          console.error("Error serving extracted figure:", error);
          return NextResponse.json({ error: "Failed to serve figure" }, { status: 500 });
     }
}
