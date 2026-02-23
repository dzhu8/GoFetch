import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, libraryFolders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/papers/[id]/figure — serve the first figure image
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper || !paper.firstFigurePath) {
               return NextResponse.json({ error: "Figure not found" }, { status: 404 });
          }

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, paper.folderId)).get();
          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          const figPath = path.join(folder.rootPath, paper.firstFigurePath);
          if (!fs.existsSync(figPath)) {
               return NextResponse.json({ error: "Figure file not found on disk" }, { status: 404 });
          }

          const fileBuffer = fs.readFileSync(figPath);
          const ext = path.extname(figPath).toLowerCase();
          const mimeType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

          return new NextResponse(fileBuffer, {
               headers: {
                    "Content-Type": mimeType,
                    "Content-Length": String(fileBuffer.length),
                    "Cache-Control": "public, max-age=3600",
               },
          });
     } catch (error) {
          console.error("Error serving figure:", error);
          return NextResponse.json({ error: "Failed to serve figure" }, { status: 500 });
     }
}
