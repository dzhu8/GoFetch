import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import db from "@/server/db";
import {
     papers,
     paperChunks,
     paperChunkEmbeddings,
     paperMetadataCache,
     paperAbstractEmbeddings,
     paperSourceLinks,
     libraryFolders,
} from "@/server/db/schema";
import configManager from "@/server";
import modelRegistry from "@/server/providerRegistry";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import type { MinimalProvider } from "@/lib/models/types";
import type { ModelPreference } from "@/lib/models/modelPreference";

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchScope = "papers" | "web_abstracts" | "both";

export interface SearchRequest {
     query: string;
     /** Null / empty = search across entire library */
     folderIds: number[] | null;
     searchScope: SearchScope;
     /** Override the default embedding model */
     embeddingModel: ModelPreference | null;
     /** Max results to return — falls back to personalization.snowballMaxPapers */
     topN?: number;
}

export interface ChunkResult {
     type: "chunk";
     score: number;
     paperId: number;
     paperTitle: string | null;
     paperFileName: string;
     paperDoi: string | null;
     folderId: number;
     chunkId: number;
     sectionType: string;
     content: string;
}

export interface AbstractResult {
     type: "abstract";
     score: number;
     s2PaperId: string;
     title: string | null;
     abstract: string;
     authors: string | null;
     year: number | null;
     venue: string | null;
     doi: string | null;
     s2Url: string | null;
     /** IDs of library papers that reference this S2 paper */
     sourcePaperIds: number[];
     minDepth: number;
}

export type SearchResult = ChunkResult | AbstractResult;

export interface LibrarySearchResponse {
     results: SearchResult[];
     embeddingModel: string;
     totalCandidates: number;
     embeddedOnTheFly: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Route ────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
     try {
          const body: SearchRequest = await req.json();
          const { query, folderIds, searchScope = "both", embeddingModel: requestedModel } = body;

          if (!query?.trim()) {
               return NextResponse.json({ error: "query is required" }, { status: 400 });
          }

          const topN: number =
               body.topN ??
               (configManager.getConfig("personalization.snowballMaxPapers") as number | undefined) ??
               50;

          // ── Resolve embedding model ────────────────────────────────────
          const snapshot = configManager.getAllConfig() as {
               preferences?: { defaultEmbeddingModel?: ModelPreference | null };
          };
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

          // ── Embed the query ────────────────────────────────────────────
          const [queryVec] = await embModel.embedDocuments([query.trim()]);

          let embeddedOnTheFly = 0;
          const candidates: Array<{ vec: number[]; result: SearchResult }> = [];

          // ── Determine which library folders to search ──────────────────
          let targetFolderIds: number[];
          if (folderIds && folderIds.length > 0) {
               targetFolderIds = folderIds;
          } else {
               const allFolders = db.select({ id: libraryFolders.id }).from(libraryFolders).all();
               targetFolderIds = allFolders.map((f) => f.id);
          }

          // ── Collect seed paper IDs from target folders ─────────────────
          const seedPapers =
               targetFolderIds.length > 0
                    ? db
                           .select({ id: papers.id, title: papers.title, fileName: papers.fileName, doi: papers.doi, folderId: papers.folderId, semanticScholarId: papers.semanticScholarId })
                           .from(papers)
                           .where(inArray(papers.folderId, targetFolderIds))
                           .all()
                    : [];

          const seedPaperIds = seedPapers.map((p) => p.id);
          const seedPaperMap = new Map(seedPapers.map((p) => [p.id, p]));

          // ── SCOPE: paper chunks ────────────────────────────────────────
          if ((searchScope === "papers" || searchScope === "both") && seedPaperIds.length > 0) {
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

               if (chunks.length > 0) {
                    // Fetch cached per-model embeddings
                    const chunkIds = chunks.map((c) => c.id);
                    const cachedEmbs = db
                         .select({ chunkId: paperChunkEmbeddings.chunkId, embedding: paperChunkEmbeddings.embedding })
                         .from(paperChunkEmbeddings)
                         .where(
                              and(
                                   inArray(paperChunkEmbeddings.chunkId, chunkIds),
                                   eq(paperChunkEmbeddings.modelKey, modelKey),
                              ),
                         )
                         .all();
                    const embMap = new Map(cachedEmbs.map((e) => [e.chunkId, bufToVector(e.embedding as Buffer)]));

                    // Collect chunks needing fresh embedding
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
                              embeddedOnTheFly += batch.length;
                         }
                    }

                    for (const chunk of chunks) {
                         const vec = embMap.get(chunk.id);
                         if (!vec) continue;
                         const paper = seedPaperMap.get(chunk.paperId);
                         if (!paper) continue;
                         candidates.push({
                              vec,
                              result: {
                                   type: "chunk",
                                   score: 0,
                                   paperId: chunk.paperId,
                                   paperTitle: paper.title,
                                   paperFileName: paper.fileName,
                                   paperDoi: paper.doi,
                                   folderId: paper.folderId,
                                   chunkId: chunk.id,
                                   sectionType: chunk.sectionType,
                                   content: chunk.content,
                              } satisfies ChunkResult,
                         });
                    }
               }
          }

          // ── SCOPE: web abstracts from paperMetadataCache ───────────────
          if (searchScope === "web_abstracts" || searchScope === "both") {
               // Collect S2 paper IDs reachable within depth ≤ 2 from any seed paper
               const linkRows =
                    seedPaperIds.length > 0
                         ? db
                                .select({
                                     s2PaperId: paperSourceLinks.s2PaperId,
                                     sourcePaperId: paperSourceLinks.sourcePaperId,
                                     depth: paperSourceLinks.depth,
                                })
                                .from(paperSourceLinks)
                                .where(
                                     and(
                                          inArray(paperSourceLinks.sourcePaperId, seedPaperIds),
                                          // depth <= 2
                                     ),
                                )
                                .all()
                                .filter((r) => r.depth <= 2)
                         : [];

               // Group by s2PaperId
               const s2Map = new Map<string, { sourcePaperIds: number[]; minDepth: number }>();
               for (const row of linkRows) {
                    const existing = s2Map.get(row.s2PaperId);
                    if (existing) {
                         if (!existing.sourcePaperIds.includes(row.sourcePaperId)) {
                              existing.sourcePaperIds.push(row.sourcePaperId);
                         }
                         existing.minDepth = Math.min(existing.minDepth, row.depth);
                    } else {
                         s2Map.set(row.s2PaperId, { sourcePaperIds: [row.sourcePaperId], minDepth: row.depth });
                    }
               }

               const s2Ids = Array.from(s2Map.keys());
               if (s2Ids.length > 0) {
                    const metaRows = db
                         .select({
                              paperId: paperMetadataCache.paperId,
                              abstract: paperMetadataCache.abstract,
                              title: paperMetadataCache.title,
                              dataJson: paperMetadataCache.dataJson,
                         })
                         .from(paperMetadataCache)
                         .where(and(inArray(paperMetadataCache.paperId, s2Ids), isNotNull(paperMetadataCache.abstract)))
                         .all()
                         .filter((r) => r.abstract && r.abstract.trim().length > 0);

                    if (metaRows.length > 0) {
                         const metaIds = metaRows.map((r) => r.paperId);

                         // Fetch cached per-model abstract embeddings
                         const cachedAbstEmbs = db
                              .select({ paperId: paperAbstractEmbeddings.paperId, embedding: paperAbstractEmbeddings.embedding })
                              .from(paperAbstractEmbeddings)
                              .where(
                                   and(
                                        inArray(paperAbstractEmbeddings.paperId, metaIds),
                                        eq(paperAbstractEmbeddings.modelKey, modelKey),
                                   ),
                              )
                              .all();
                         const abstEmbMap = new Map(cachedAbstEmbs.map((e) => [e.paperId, bufToVector(e.embedding as Buffer)]));

                         // Embed missing abstracts
                         const metaNeedingEmbed = metaRows.filter((r) => !abstEmbMap.has(r.paperId));
                         if (metaNeedingEmbed.length > 0) {
                              const BATCH = 32;
                              for (let i = 0; i < metaNeedingEmbed.length; i += BATCH) {
                                   const batch = metaNeedingEmbed.slice(i, i + BATCH);
                                   const vecs = await embModel.embedDocuments(batch.map((r) => r.abstract!));
                                   db.transaction((tx) => {
                                        for (let j = 0; j < batch.length; j++) {
                                             const buf = vecToBuffer(vecs[j]);
                                             const now = Date.now();
                                             tx.insert(paperAbstractEmbeddings)
                                                  .values({ paperId: batch[j].paperId, modelKey, embedding: buf, createdAt: now })
                                                  .onConflictDoUpdate({
                                                       target: [paperAbstractEmbeddings.paperId, paperAbstractEmbeddings.modelKey],
                                                       set: { embedding: buf, createdAt: now },
                                                  })
                                                  .run();
                                             abstEmbMap.set(batch[j].paperId, vecs[j]);
                                        }
                                   });
                                   embeddedOnTheFly += batch.length;
                              }
                         }

                         for (const meta of metaRows) {
                              const vec = abstEmbMap.get(meta.paperId);
                              if (!vec) continue;
                              const link = s2Map.get(meta.paperId);
                              if (!link) continue;

                              let parsedData: Record<string, unknown> = {};
                              try { parsedData = JSON.parse(meta.dataJson); } catch { /* ignore */ }

                              const rawAuthors: Array<{ name: string }> = (parsedData.authors as Array<{ name: string }>) ?? [];
                              const authorNames = rawAuthors.slice(0, 3).map((a) => a.name);
                              const authors = rawAuthors.length > 3 ? `${authorNames.join(", ")} et al.` : authorNames.join(", ");

                              const extIds = (parsedData.externalIds ?? {}) as Record<string, string>;
                              let s2Url: string | null = null;
                              if (extIds.DOI) s2Url = `https://doi.org/${encodeURIComponent(extIds.DOI)}`;
                              else if (extIds.ArXiv) s2Url = `https://arxiv.org/abs/${extIds.ArXiv}`;
                              else if (typeof parsedData.url === "string") s2Url = parsedData.url;

                              candidates.push({
                                   vec,
                                   result: {
                                        type: "abstract",
                                        score: 0,
                                        s2PaperId: meta.paperId,
                                        title: meta.title,
                                        abstract: meta.abstract!,
                                        authors: authors || null,
                                        year: typeof parsedData.year === "number" ? parsedData.year : null,
                                        venue: typeof parsedData.venue === "string" ? parsedData.venue : null,
                                        doi: extIds.DOI ?? null,
                                        s2Url,
                                        sourcePaperIds: link.sourcePaperIds,
                                        minDepth: link.minDepth,
                                   } satisfies AbstractResult,
                              });
                         }
                    }
               }
          }

          // ── Rank by cosine similarity ──────────────────────────────────
          const ranked = candidates
               .map(({ vec, result }) => ({ ...result, score: cosineSimilarity(queryVec, vec) }))
               .sort((a, b) => b.score - a.score)
               .slice(0, topN);

          return NextResponse.json({
               results: ranked,
               embeddingModel: modelKey,
               totalCandidates: candidates.length,
               embeddedOnTheFly,
          } satisfies LibrarySearchResponse);
     } catch (err) {
          console.error("[library-search] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
