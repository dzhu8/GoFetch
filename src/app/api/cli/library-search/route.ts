import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import db from "@/server/db";
import {
     papers,
     paperChunks,
     paperChunkEmbeddings,
     libraryFolders,
} from "@/server/db/schema";
import configManager from "@/server";
import modelRegistry from "@/server/providerRegistry";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import type { MinimalProvider } from "@/lib/models/types";
import type { ModelPreference } from "@/lib/models/modelPreference";

/**
 * CLI Library Search API
 * 
 * Performs a semantic search over the local research library using the configured embedding model.
 * 
 * ── Request body fields ────────────────────────────────────────────────────
 * Required:
 *   query            string    The natural language search query.
 * 
 * Optional:
 *   folderIds        number[]  Restrict results to these folder IDs.
 *   folderNames      string[]  Restrict results to these folder names (mapped to IDs).
 *   topN             number    Maximum results to return (default: 50).
 *   embeddingModel   object    Override default model { providerId: string, modelKey: string }.
 * 
 * ── Example cURL command ───────────────────────────────────────────────────
 * 
 * curl -X POST http://localhost:3000/api/cli/library-search \
 *   -H "Content-Type: application/json" \
 *   -d '{ "query": "Transformer architecture", "topN": 5, "folderNames": ["Robotics"] }'
 */

function bufToVector(buf: Buffer): number[] {
     return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

function vecToBuffer(vec: number[]): Buffer {
     return Buffer.from(new Float32Array(vec).buffer);
}

function cosineSimilarity(a: number[], b: number[]): number {
     if (a.length !== b.length || a.length === 0) return 0;
     let dot = 0, magA = 0, magB = 0;
     for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i];
          magA += a[i] * a[i];
          magB += b[i] * b[i];
     }
     const denom = Math.sqrt(magA) * Math.sqrt(magB);
     return denom === 0 ? 0 : dot / denom;
}

export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const { 
               query, 
               folderIds, 
               folderNames, 
               embeddingModel: requestedModel, 
               topN: requestedTopN 
          } = body;

          if (!query?.trim()) {
               return NextResponse.json({ error: "query is required" }, { status: 400 });
          }

          const topN = requestedTopN ?? configManager.getConfig("personalization.snowballMaxPapers") ?? 50;

          // 1. Resolve Embedding Model
          const snapshot = configManager.getAllConfig();
          const providers = modelRegistry.getProviders().map((p) => ({
               id: p.id,
               name: p.name,
               type: p.type,
               chatModels: p.chatModels ?? [],
               embeddingModels: p.embeddingModels ?? [],
               ocrModels: p.ocrModels ?? [],
          })) as MinimalProvider[];

          const modelPref = resolveModelPreference(
               "embedding",
               providers,
               requestedModel ?? snapshot.preferences?.defaultEmbeddingModel,
          );

          const provider = modelRegistry.getProviderById(modelPref.providerId);
          if (!provider) {
               return NextResponse.json({ error: `Provider ${modelPref.providerId} not found` }, { status: 500 });
          }
          const embModel = await provider.provider.loadEmbeddingModel(modelPref.modelKey);
          const modelKey = `${modelPref.providerId}/${modelPref.modelKey}`;

          // 2. Embed Query
          const [queryVec] = await embModel.embedDocuments([query.trim()]);

          // 3. Target Folders
          let targetFolderIds: number[] = folderIds || [];

          // Map folder names to IDs if provided
          if (folderNames && Array.isArray(folderNames) && folderNames.length > 0) {
               const folderRows = db
                    .select({ id: libraryFolders.id })
                    .from(libraryFolders)
                    .where(inArray(libraryFolders.name, folderNames))
                    .all();
               
               const mappedIds = folderRows.map(f => f.id);
               targetFolderIds = Array.from(new Set([...targetFolderIds, ...mappedIds]));
          }

          if (targetFolderIds.length === 0 && (!folderIds || folderIds.length === 0) && (!folderNames || folderNames.length === 0)) {
               const allFolders = db.select({ id: libraryFolders.id }).from(libraryFolders).all();
               targetFolderIds = allFolders.map((f) => f.id);
          }

          if (targetFolderIds.length === 0) {
              return NextResponse.json({ results: [], totalCandidates: 0 });
          }

          // 4. Fetch Chunks and Embeddings
          const seedPapers = db
               .select({ id: papers.id, title: papers.title, fileName: papers.fileName, doi: papers.doi, folderId: papers.folderId })
               .from(papers)
               .where(inArray(papers.folderId, targetFolderIds))
               .all();

          const seedPaperIds = seedPapers.map((p) => p.id);
          const seedPaperMap = new Map(seedPapers.map((p) => [p.id, p]));

          if (seedPaperIds.length === 0) {
              return NextResponse.json({ results: [], totalCandidates: 0 });
          }

          const chunks = db
               .select({
                    id: paperChunks.id,
                    paperId: paperChunks.paperId,
                    sectionType: paperChunks.sectionType,
                    content: paperChunks.content,
               })
               .from(paperChunks)
               .where(inArray(paperChunks.paperId, seedPaperIds))
               .all();

          const chunkIds = chunks.map((c) => c.id);
          const cachedEmbs = chunkIds.length > 0 
               ? db
                    .select({ chunkId: paperChunkEmbeddings.chunkId, embedding: paperChunkEmbeddings.embedding })
                    .from(paperChunkEmbeddings)
                    .where(
                         and(
                              inArray(paperChunkEmbeddings.chunkId, chunkIds),
                              eq(paperChunkEmbeddings.modelKey, modelKey),
                         ),
                    )
                    .all()
               : [];

          const embMap = new Map(cachedEmbs.map((e) => [e.chunkId, bufToVector(e.embedding as Buffer)]));
          
          // 5. Embed Missing Chunks (on-the-fly)
          const toEmbed = chunks.filter((c) => !embMap.has(c.id));
          if (toEmbed.length > 0) {
               const BATCH = 32;
               for (let i = 0; i < toEmbed.length; i += BATCH) {
                    const batch = toEmbed.slice(i, i + BATCH);
                    const vecs = await embModel.embedDocuments(batch.map((c) => c.content));
                    db.transaction((tx) => {
                         for (let j = 0; j < batch.length; j++) {
                              const buf = vecToBuffer(vecs[j]);
                              tx.insert(paperChunkEmbeddings)
                                   .values({
                                        chunkId: batch[j].id,
                                        modelKey,
                                        embedding: buf,
                                        createdAt: Date.now(),
                                   })
                                   .onConflictDoUpdate({
                                        target: [paperChunkEmbeddings.chunkId, paperChunkEmbeddings.modelKey],
                                        set: { embedding: buf, createdAt: Date.now() },
                                   })
                                   .run();
                              embMap.set(batch[j].id, vecs[j]);
                         }
                    });
               }
          }

          // 6. Rank and Respond
          const results = chunks.map((chunk) => {
               const vec = embMap.get(chunk.id);
               const paper = seedPaperMap.get(chunk.paperId);
               if (!vec || !paper) return null;

               return {
                    type: "chunk",
                    score: cosineSimilarity(queryVec, vec),
                    paperId: chunk.paperId,
                    paperTitle: paper.title,
                    paperFileName: paper.fileName,
                    paperDoi: paper.doi,
                    folderId: paper.folderId,
                    chunkId: chunk.id,
                    sectionType: chunk.sectionType,
                    content: chunk.content,
               };
          })
          .filter(Boolean)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, topN);

          return NextResponse.json({
               results,
               totalCandidates: chunks.length,
               embeddingModel: modelKey
          });

     } catch (err) {
          console.error("[CLI Library Search] Error:", err);
          return NextResponse.json({ error: "Failed to perform library search" }, { status: 500 });
     }
}
