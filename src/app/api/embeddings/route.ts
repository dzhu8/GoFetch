import type { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import db from "@/server/db";
import { embeddings } from "@/server/db/schema";

const toVector = (buffer: Buffer, dim: number) => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, dim);
     return Array.from(floatView);
};

export async function GET(req: NextRequest) {
     const folderName = req.nextUrl.searchParams.get("folderName");

     if (!folderName) {
          return NextResponse.json({ error: "folderName is required" }, { status: 400 });
     }

     try {
          const whereClause = eq(embeddings.folderName, folderName);

          const rows = db
               .select({
                    id: embeddings.id,
                    filePath: embeddings.filePath,
                    relativePath: embeddings.relativePath,
                    content: embeddings.content,
                    metadata: embeddings.metadata,
                    embedding: embeddings.embedding,
                    dim: embeddings.dim,
               })
               .from(embeddings)
               .where(whereClause)
               .all();

          const serialized = rows.map((row) => ({
               id: row.id,
               filePath: row.filePath,
               relativePath: row.relativePath,
               content: row.content,
               metadata: row.metadata ?? {},
               vector: toVector(row.embedding as Buffer, row.dim),
          }));

          return NextResponse.json({ embeddings: serialized });
     } catch (error) {
          console.error("[embeddings] Failed to fetch embeddings", error);
          return NextResponse.json({ error: "Unable to fetch embeddings" }, { status: 500 });
     }
}

export async function DELETE(req: NextRequest) {
     const folderName = req.nextUrl.searchParams.get("folderName");

     if (!folderName) {
          return NextResponse.json({ error: "folderName is required" }, { status: 400 });
     }

     try {
          const { changes } = db.delete(embeddings).where(eq(embeddings.folderName, folderName)).run();

          return NextResponse.json({ deleted: changes ?? 0 });
     } catch (error) {
          console.error("[embeddings] Failed to delete embeddings", error);
          return NextResponse.json({ error: "Unable to delete embeddings" }, { status: 500 });
     }
}
