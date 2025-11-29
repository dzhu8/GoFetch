import type { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";

import db from "@/server/db";
import { embeddings } from "@/server/db/schema";
import folderEvents from "@/server/folderEvents";

const toVector = (buffer: Buffer, dim: number) => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, dim);
     return Array.from(floatView);
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export async function GET(req: NextRequest) {
     const folderName = req.nextUrl.searchParams.get("folderName");
     const limitParam = req.nextUrl.searchParams.get("limit");
     const offsetParam = req.nextUrl.searchParams.get("offset");

     if (!folderName) {
          return NextResponse.json({ error: "folderName is required" }, { status: 400 });
     }

     const limit = Math.min(Math.max(1, parseInt(limitParam ?? "", 10) || DEFAULT_LIMIT), MAX_LIMIT);
     const offset = Math.max(0, parseInt(offsetParam ?? "", 10) || 0);

     try {
          const whereClause = eq(embeddings.folderName, folderName);

          // Get total count
          const countResult = db
               .select({ count: sql<number>`count(*)` })
               .from(embeddings)
               .where(whereClause)
               .get();
          const total = countResult?.count ?? 0;

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
               .limit(limit)
               .offset(offset)
               .all();

          const serialized = rows.map((row) => ({
               id: row.id,
               filePath: row.filePath,
               relativePath: row.relativePath,
               content: row.content,
               metadata: row.metadata ?? {},
               vector: toVector(row.embedding as Buffer, row.dim),
          }));

          return NextResponse.json({
               embeddings: serialized,
               total,
               limit,
               offset,
               hasMore: offset + rows.length < total,
          });
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

          // Notify SSE clients that embedding counts have changed
          folderEvents.notifyChange();

          return NextResponse.json({ deleted: changes ?? 0 });
     } catch (error) {
          console.error("[embeddings] Failed to delete embeddings", error);
          return NextResponse.json({ error: "Unable to delete embeddings" }, { status: 500 });
     }
}
