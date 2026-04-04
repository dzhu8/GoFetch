"use server";

import db from "@/server/db";
import {
     libraryFolders,
     papers,
     paperChunks,
     paperChunkEmbeddings,
     paperMetadataCache,
     paperAbstractEmbeddings,
     paperSourceLinks,
     librarySearchCache,
} from "@/server/db/schema";
import fs from "fs";
import path from "path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { processPaperOCR, queuePaperEmbedding } from "@/lib/embed/paperProcess";
import configManager from "@/server";
import modelRegistry from "@/server/providerRegistry";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import type { MinimalProvider } from "@/lib/models/types";
import type { ModelPreference } from "@/lib/models/modelPreference";
export type SearchScope = "papers" | "web_abstracts" | "both";

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
}

export type SearchResult = ChunkResult | AbstractResult;

export interface LibrarySearchResponse {
     results: SearchResult[];
     embeddingModel: string;
     totalCandidates: number;
     embeddedOnTheFly: number;
}

// ── Shared constants & helpers ──────────────────────────────────────────────

/** Central directory where all GoFetch-managed library folders live */
const LIBRARY_ROOT = path.join(process.cwd(), "data", "library");

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

// ── Server Actions ──────────────────────────────────────────────────────────

/** GET /api/library-folders -> getLibraryFolders() */
export async function getLibraryFolders() {
     try {
          ensureLibraryRoot();
          const rows = db.select().from(libraryFolders).orderBy(libraryFolders.createdAt).all();

          // Trigger background embedding checks for each folder
          for (const folder of rows) {
               triggerPendingEmbeddings(folder.id, folder.name).catch(console.error);
          }

          return { folders: rows, libraryRoot: LIBRARY_ROOT };
     } catch (error) {
          console.error("Error fetching library folders:", error);
          return { error: "Failed to fetch library folders" };
     }
}

/** POST /api/library-folders -> createLibraryFolder(name, rootPath?) */
export async function createLibraryFolder(name: string, rootPath?: string) {
     try {
          ensureLibraryRoot();
          const trimmedName = typeof name === "string" ? name.trim() : "";
          const trimmedRoot = typeof rootPath === "string" ? rootPath.trim() : "";

          if (!trimmedName) {
               return { error: "Folder name is required" };
          }

          const resolvedPath = trimmedRoot || path.join(LIBRARY_ROOT, trimmedName);

          if (fs.existsSync(resolvedPath)) {
               return { error: `A folder named "${trimmedName}" already exists in the library directory.` };
          }

          fs.mkdirSync(resolvedPath, { recursive: true });

          const row = db
               .insert(libraryFolders)
               .values({ name: trimmedName, rootPath: resolvedPath })
               .returning()
               .get();

          return { folder: row };
     } catch (error: any) {
          console.error("Error creating library folder:", error);
          if (error?.message?.includes("UNIQUE constraint failed")) {
               return { error: "A folder with that name already exists" };
          }
          return { error: "Failed to create library folder" };
     }
}

/** GET /api/library-folders/[id] -> getLibraryFolder(id) */
export async function getLibraryFolder(id: string) {
     try {
          const folderId = parseInt(id, 10);
          if (isNaN(folderId)) {
               return { error: "Invalid folder ID" };
          }

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          if (!folder) {
               return { error: "Folder not found" };
          }

          return { folder };
     } catch (error) {
          console.error("Error fetching library folder:", error);
          return { error: "Failed to fetch library folder" };
     }
}

/** DELETE /api/library-folders/[id] -> deleteLibraryFolder(id) */
export async function deleteLibraryFolder(id: string) {
     try {
          const folderId = parseInt(id, 10);
          if (isNaN(folderId)) {
               return { error: "Invalid folder ID" };
          }

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          if (!folder) {
               return { error: "Folder not found" };
          }

          // Delete folder (papers cascade via FK)
          db.delete(libraryFolders).where(eq(libraryFolders.id, folderId)).run();

          return { message: "Folder deleted successfully" };
     } catch (error) {
          console.error("Error deleting library folder:", error);
          return { error: "Failed to delete library folder" };
     }
}

/** POST /api/library-search -> searchLibrary(...) */
export async function searchLibrary(
     query: string,
     folderIds?: number[] | null,
     searchScope?: string,
     embeddingModel?: { providerId: string; modelKey: string },
     topN?: number,
) {
     try {
          const scope = (searchScope ?? "both") as SearchScope;

          if (!query?.trim()) {
               return { error: "query is required" };
          }

          const resolvedTopN: number =
               topN ??
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
               embeddingModel ?? snapshot.preferences?.defaultEmbeddingModel,
          );

          const provider = modelRegistry.getProviderById(modelPref.providerId);
          if (!provider) {
               return { error: `Provider ${modelPref.providerId} not found` };
          }
          const embModel = await provider.provider.loadEmbeddingModel(modelPref.modelKey);
          const modelKey = `${modelPref.providerId}/${modelPref.modelKey}`;

          // ── Relevant Settings for Cache ───────────────────────────────
          const personalization = configManager.getConfig("personalization") || {};
          const settingsHash = JSON.stringify({
               topN: resolvedTopN,
               graphDepth: personalization.snowballDepth,
               graphMaxPapers: personalization.snowballMaxPapers,
               bcThreshold: personalization.snowballBcThreshold,
               ccThreshold: personalization.snowballCcThreshold,
               embThreshold: personalization.snowballEmbeddingThreshold,
          });

          // ── Check Cache ───────────────────────────────────────────────
          const normalizedQuery = query.trim().toLowerCase();
          let targetFolderIds: number[];
          if (folderIds && folderIds.length > 0) {
               targetFolderIds = [...folderIds].sort((a, b) => a - b);
          } else {
               const allFolders = db.select({ id: libraryFolders.id }).from(libraryFolders).all();
               targetFolderIds = allFolders.map((f) => f.id).sort((a, b) => a - b);
          }
          const folderIdsJson = JSON.stringify(targetFolderIds);

          const cached = db
               .select()
               .from(librarySearchCache)
               .where(
                    and(
                         eq(librarySearchCache.query, normalizedQuery),
                         eq(librarySearchCache.folderIdsJson, folderIdsJson),
                         eq(librarySearchCache.searchScope, scope),
                         eq(librarySearchCache.modelKey, modelKey),
                         eq(librarySearchCache.settingsHash, settingsHash),
                    ),
               )
               .get();

          if (cached) {
               try {
                    const results = JSON.parse(cached.resultsJson) as SearchResult[];
                    return {
                         results,
                         embeddingModel: modelKey,
                         totalCandidates: results.length,
                         embeddedOnTheFly: 0,
                         fromCache: true,
                    } satisfies LibrarySearchResponse & { fromCache: boolean };
               } catch (e) {
                    console.error("[library-search] Cache parse error:", e);
               }
          }

          // ── Embed the query ────────────────────────────────────────────
          const [queryVec] = await embModel.embedDocuments([query.trim()]);

          let embeddedOnTheFly = 0;
          const candidates: Array<{ vec: number[]; result: SearchResult }> = [];

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
          if ((scope === "papers" || scope === "both") && seedPaperIds.length > 0) {
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
          if (scope === "web_abstracts" || scope === "both") {
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
                                     ),
                                )
                                .all()
                                .filter((r) => r.depth <= 2)
                         : [];

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
               .slice(0, resolvedTopN);

          // ── Save to Cache ──────────────────────────────────────────────
          db.insert(librarySearchCache)
               .values({
                    query: normalizedQuery,
                    folderIdsJson,
                    searchScope: scope,
                    modelKey,
                    settingsHash,
                    resultsJson: JSON.stringify(ranked),
                    createdAt: Date.now(),
               })
               .onConflictDoUpdate({
                    target: [
                         librarySearchCache.query,
                         librarySearchCache.folderIdsJson,
                         librarySearchCache.searchScope,
                         librarySearchCache.modelKey,
                         librarySearchCache.settingsHash,
                    ],
                    set: {
                         resultsJson: JSON.stringify(ranked),
                         createdAt: Date.now(),
                    },
               })
               .run();

          return {
               results: ranked,
               embeddingModel: modelKey,
               totalCandidates: candidates.length,
               embeddedOnTheFly,
          } satisfies LibrarySearchResponse;
     } catch (err) {
          console.error("[library-search] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return { error: msg };
     }
}
