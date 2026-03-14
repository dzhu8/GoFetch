import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { libraryFolders, papers, paperChunks } from "@/server/db/schema";
import fs from "fs";
import path from "path";
import { eq, isNull } from "drizzle-orm";
import { processPaperOCR, queuePaperEmbedding } from "@/lib/embed/paperProcess";

/** Central directory where all GoFetch-managed library folders live */
export const LIBRARY_ROOT = path.join(process.cwd(), "data", "library");

function ensureLibraryRoot() {
     if (!fs.existsSync(LIBRARY_ROOT)) {
          fs.mkdirSync(LIBRARY_ROOT, { recursive: true });
     }
}

async function triggerPendingEmbeddings(folderId: number, folderName: string) {
     const papersToEmbed = db
          .select({ id: papers.id, fileName: papers.fileName, filePath: papers.filePath })
          .from(papers)
          .leftJoin(paperChunks, eq(papers.id, paperChunks.paperId))
          .where(eq(papers.folderId, folderId))
          .all()
          .filter((p, i, self) => {
               // Filter for papers that have NO chunks in paperChunks table
               const hasChunks = db.select().from(paperChunks).where(eq(paperChunks.paperId, p.id)).limit(1).get();
               return !hasChunks;
          });

     for (const paper of papersToEmbed) {
          const ocrFileName = paper.fileName.replace(/\.pdf$/i, "") + ".ocr.json";
          const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";

          if (fs.existsSync(ocrPath)) {
               try {
                    await processPaperOCR(paper.id, ocrPath);
                    queuePaperEmbedding(paper.id, folderName, paper.fileName);
               } catch (err) {
                    console.warn(`[Library] Failed to process pending embedding for ${paper.fileName}:`, err);
               }
          }
     }
}

// GET /api/library-folders — list all library folders
export async function GET() {
     try {
          ensureLibraryRoot();
          const rows = db.select().from(libraryFolders).orderBy(libraryFolders.createdAt).all();

          // Trigger background embedding checks for each folder
          for (const folder of rows) {
               triggerPendingEmbeddings(folder.id, folder.name).catch(console.error);
          }

          return NextResponse.json({ folders: rows, libraryRoot: LIBRARY_ROOT });
     } catch (error) {
          console.error("Error fetching library folders:", error);
          return NextResponse.json({ error: "Failed to fetch library folders" }, { status: 500 });
     }
}

// POST /api/library-folders — create a new library folder
// rootPath is optional; if omitted, defaults to LIBRARY_ROOT/name
export async function POST(req: NextRequest) {
     try {
          ensureLibraryRoot();
          const body = await req.json();
          const name = typeof body.name === "string" ? body.name.trim() : "";
          const rootPath = typeof body.rootPath === "string" ? body.rootPath.trim() : "";

          if (!name) {
               return NextResponse.json({ error: "Folder name is required" }, { status: 400 });
          }

          const resolvedPath = rootPath || path.join(LIBRARY_ROOT, name);

          if (fs.existsSync(resolvedPath)) {
               return NextResponse.json(
                    { error: `A folder named "${name}" already exists in the library directory.` },
                    { status: 409 }
               );
          }

          fs.mkdirSync(resolvedPath, { recursive: true });

          const row = db
               .insert(libraryFolders)
               .values({ name, rootPath: resolvedPath })
               .returning()
               .get();

          return NextResponse.json({ folder: row }, { status: 201 });
     } catch (error: any) {
          console.error("Error creating library folder:", error);
          if (error?.message?.includes("UNIQUE constraint failed")) {
               return NextResponse.json({ error: "A folder with that name already exists" }, { status: 409 });
          }
          return NextResponse.json({ error: "Failed to create library folder" }, { status: 500 });
     }
}
