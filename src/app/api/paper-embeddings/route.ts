import { NextRequest, NextResponse } from "next/server";
import { isNotNull, and, eq } from "drizzle-orm";
import type { Buffer } from "node:buffer";

import db from "@/server/db";
import { paperChunks, papers } from "@/server/db/schema";

const toVector = (buffer: Buffer): number[] => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
     return Array.from(floatView);
};

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 10000;

export async function GET(req: NextRequest) {
     const folderIdParam = req.nextUrl.searchParams.get("folderId");
     const limitParam = req.nextUrl.searchParams.get("limit");
     const offsetParam = req.nextUrl.searchParams.get("offset");

     const limit = Math.min(Math.max(1, parseInt(limitParam ?? "", 10) || DEFAULT_LIMIT), MAX_LIMIT);
     const offset = Math.max(0, parseInt(offsetParam ?? "", 10) || 0);

     try {
          const condition = folderIdParam
               ? and(isNotNull(paperChunks.embedding), eq(papers.folderId, parseInt(folderIdParam, 10)))
               : isNotNull(paperChunks.embedding);

          const rows = db
               .select({
                    id: paperChunks.id,
                    paperId: paperChunks.paperId,
                    sectionType: paperChunks.sectionType,
                    chunkIndex: paperChunks.chunkIndex,
                    content: paperChunks.content,
                    embedding: paperChunks.embedding,
                    fileName: papers.fileName,
                    title: papers.title,
               })
               .from(paperChunks)
               .innerJoin(papers, eq(paperChunks.paperId, papers.id))
               .where(condition)
               .limit(limit)
               .offset(offset)
               .all();

          const serialized = rows
               .filter((row) => row.embedding)
               .map((row) => ({
                    id: row.id,
                    paperId: row.paperId,
                    sectionType: row.sectionType,
                    chunkIndex: row.chunkIndex,
                    content: row.content,
                    fileName: row.fileName,
                    title: row.title,
                    vector: toVector(row.embedding as Buffer),
               }))
               .filter((row) => row.vector.length > 0);

          return NextResponse.json({ chunks: serialized, total: serialized.length });
     } catch (error) {
          console.error("[paper-embeddings] Failed to fetch", error);
          return NextResponse.json({ error: "Unable to fetch paper embeddings" }, { status: 500 });
     }
}
