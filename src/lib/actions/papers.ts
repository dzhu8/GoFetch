"use server";

import db from "@/server/db";
import {
     papers,
     libraryFolders,
     paperChunks,
     paperFolderLinks,
     relatedPapers,
     paperSourceLinks,
} from "@/server/db/schema";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import fs from "fs";
import type { Buffer } from "node:buffer";
import { processPaperOCR, queuePaperEmbedding } from "@/lib/embed/paperProcess";
import { extractDocumentMetadata } from "@/lib/citations/parseReferences";
import configManager from "@/server";
import { buildRelatedPapersGraph, GraphConstructionMethod } from "@/lib/relatedPapers/graph";
import { activeProcs } from "@/app/api/papers/upload/processRegistry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function triggerPendingEmbeddings(folderId: number, folderName: string): Promise<boolean> {
     const papersToEmbed = db
          .select({ id: papers.id, fileName: papers.fileName, filePath: papers.filePath, status: papers.status })
          .from(papers)
          .where(eq(papers.folderId, folderId))
          .all()
          .filter((p) => {
               // Skip papers already marked as errored — they need manual retry.
               if (p.status === "error") return false;

               const hasChunks = db
                    .select()
                    .from(paperChunks)
                    .where(eq(paperChunks.paperId, p.id))
                    .limit(1)
                    .get();
               return !hasChunks;
          });

     let triggered = false;
     for (const paper of papersToEmbed) {
          const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          if (fs.existsSync(ocrPath)) {
               try {
                    await processPaperOCR(paper.id, ocrPath);
                    queuePaperEmbedding(paper.id, folderName, paper.fileName);
                    triggered = true;
               } catch (err) {
                    console.warn(`[Library] Failed to process pending embedding for ${paper.fileName}:`, err);
                    // Mark paper as errored so it isn't re-triggered on every folder open.
                    db.update(papers)
                         .set({ status: "error", updatedAt: new Date().toISOString() })
                         .where(eq(papers.id, paper.id))
                         .run();
               }
          } else if (
               (paper.status === "uploading" || paper.status === "processing") &&
               !activeProcs.has(paper.id)
          ) {
               // OCR file missing and no active child process — this paper is orphaned.
               console.warn(`[Library] Orphaned paper detected (no OCR output, no active process): ${paper.fileName}`);
               db.update(papers)
                    .set({ status: "error", updatedAt: new Date().toISOString() })
                    .where(eq(papers.id, paper.id))
                    .run();
          }
     }
     return triggered;
}

const toVector = (buffer: Buffer): number[] => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
     return Array.from(floatView);
};

function tryUnlink(filePath: string | null | undefined) {
     if (!filePath) return;
     try {
          fs.rmSync(filePath, { force: true });
     } catch {
          // Best-effort
     }
}

// ---------------------------------------------------------------------------
// List all ready papers (for PDF context selector)
// ---------------------------------------------------------------------------

export async function listReadyPapers() {
     try {
          const rows = db
               .select({
                    id: papers.id,
                    title: papers.title,
                    fileName: papers.fileName,
               })
               .from(papers)
               .where(eq(papers.status, "ready"))
               .orderBy(papers.createdAt)
               .all();

          return { papers: rows };
     } catch (error) {
          console.error("Error listing ready papers:", error);
          return { error: "Failed to list papers" };
     }
}

// ---------------------------------------------------------------------------
// GET /api/papers?folderId=123
// ---------------------------------------------------------------------------

export async function getPapers(folderId: number) {
     try {
          // Collect paper IDs that appear in this folder via secondary links
          const secondaryLinks = db
               .select({ paperId: paperFolderLinks.paperId })
               .from(paperFolderLinks)
               .where(eq(paperFolderLinks.folderId, folderId))
               .all();
          const secondaryIds = secondaryLinks.map((l) => l.paperId);

          const rows =
               secondaryIds.length > 0
                    ? db
                           .select()
                           .from(papers)
                           .where(or(eq(papers.folderId, folderId), inArray(papers.id, secondaryIds)))
                           .orderBy(papers.createdAt)
                           .all()
                    : db
                           .select()
                           .from(papers)
                           .where(eq(papers.folderId, folderId))
                           .orderBy(papers.createdAt)
                           .all();

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          let embeddingTriggered = false;
          if (folder) {
               embeddingTriggered = await triggerPendingEmbeddings(folder.id, folder.name).catch((e) => {
                    console.error(e);
                    return false;
               });
          }

          return { papers: rows, embeddingTriggered, folderName: folder?.name ?? null };
     } catch (error) {
          console.error("Error fetching papers:", error);
          return { error: "Failed to fetch papers" };
     }
}

// ---------------------------------------------------------------------------
// GET /api/papers/[id]
// ---------------------------------------------------------------------------

export async function getPaper(id: string) {
     try {
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return { error: "Invalid paper ID" };
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper) {
               return { error: "Paper not found" };
          }

          return { paper };
     } catch (error) {
          console.error("Error fetching paper:", error);
          return { error: "Failed to fetch paper" };
     }
}

// ---------------------------------------------------------------------------
// DELETE /api/papers/[id]?folderId=N
// ---------------------------------------------------------------------------

export async function deletePaper(id: string, folderId?: number) {
     try {
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return { error: "Invalid paper ID" };
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper) {
               return { error: "Paper not found" };
          }

          const targetFolderId = folderId ?? null;

          if (targetFolderId !== null && !isNaN(targetFolderId)) {
               const isCanonicalFolder = paper.folderId === targetFolderId;
               const secondaryLinks = db
                    .select()
                    .from(paperFolderLinks)
                    .where(eq(paperFolderLinks.paperId, paperId))
                    .all();

               if (!isCanonicalFolder) {
                    // Secondary-link removal -- just delete the link
                    db.delete(paperFolderLinks)
                         .where(
                              and(
                                   eq(paperFolderLinks.paperId, paperId),
                                   eq(paperFolderLinks.folderId, targetFolderId),
                              ),
                         )
                         .run();
                    return { message: "Paper removed from folder." };
               }

               // Removing from canonical folder
               if (secondaryLinks.length > 0) {
                    // Re-home: promote first secondary link to canonical
                    const newHome = secondaryLinks[0];
                    db.update(papers)
                         .set({ folderId: newHome.folderId, updatedAt: new Date().toISOString() })
                         .where(eq(papers.id, paperId))
                         .run();
                    db.delete(paperFolderLinks)
                         .where(
                              and(
                                   eq(paperFolderLinks.paperId, paperId),
                                   eq(paperFolderLinks.folderId, newHome.folderId),
                              ),
                         )
                         .run();
                    return { message: "Paper removed from folder." };
               }
               // No other associations -- fall through to full delete below
          }

          // Full delete: remove file, figure, chunks, and record
          if (fs.existsSync(paper.filePath)) {
               fs.unlinkSync(paper.filePath);
          }

          if (paper.firstFigurePath) {
               const folder = db
                    .select()
                    .from(libraryFolders)
                    .where(eq(libraryFolders.id, paper.folderId))
                    .get();
               if (folder) {
                    const figPath = require("path").join(folder.rootPath, paper.firstFigurePath);
                    if (fs.existsSync(figPath)) {
                         fs.unlinkSync(figPath);
                    }
               }
          }

          db.delete(paperChunks).where(eq(paperChunks.paperId, paperId)).run();
          db.delete(papers).where(eq(papers.id, paperId)).run();

          return { message: "Paper deleted successfully" };
     } catch (error) {
          console.error("Error deleting paper:", error);
          return { error: "Failed to delete paper" };
     }
}

// ---------------------------------------------------------------------------
// DELETE /api/papers/[id]/embeddings
// ---------------------------------------------------------------------------

export async function deletePaperEmbeddings(id: string) {
     try {
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return { error: "Invalid paper ID" };
          }

          // Simply set embedding to null for all chunks of this paper
          db.update(paperChunks)
               .set({ embedding: null })
               .where(eq(paperChunks.paperId, paperId))
               .run();

          return { message: "Embeddings deleted successfully" };
     } catch (error) {
          console.error("Error deleting embeddings:", error);
          return { error: "Failed to delete embeddings" };
     }
}

// ---------------------------------------------------------------------------
// POST /api/papers/[id]/embeddings
// ---------------------------------------------------------------------------

export async function recomputePaperEmbeddings(id: string) {
     try {
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return { error: "Invalid paper ID" };
          }

          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper) {
               return { error: "Paper not found" };
          }

          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, paper.folderId)).get();
          if (!folder) {
               return { error: "Folder not found" };
          }

          const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          if (!fs.existsSync(ocrPath)) {
               return { error: "OCR result not found. Please delete this paper and re-upload it." };
          }

          // Clear error status so the paper shows as in-progress
          if (paper.status === "error") {
               db.update(papers)
                    .set({ status: "ready", updatedAt: new Date().toISOString() })
                    .where(eq(papers.id, paperId))
                    .run();
          }

          // Re-process chunks from OCR if they were somehow lost or need refresh
          await processPaperOCR(paper.id, ocrPath);

          // Queue the actual embedding process
          queuePaperEmbedding(paper.id, folder.name, paper.fileName);

          return { message: "Embedding process queued" };
     } catch (error) {
          console.error("Error recomputing embeddings:", error);
          return { error: "Failed to recompute embeddings" };
     }
}

// ---------------------------------------------------------------------------
// GET /api/papers/[id]/related-papers?method=bibliographic|embedding
// ---------------------------------------------------------------------------

export async function getRelatedPapers(id: string, method?: string) {
     try {
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return { error: "Invalid paper ID" };
          }

          const configuredMethod = configManager.getConfig("personalization.graphRankMethod") || "bibliographic";
          const requestedMethod = method || configuredMethod;

          // Fetch results for the requested method
          const results = db
               .select()
               .from(relatedPapers)
               .where(and(eq(relatedPapers.paperId, paperId), eq(relatedPapers.rankMethod, requestedMethod)))
               .all();

          // Check which methods have cached results
          const allResults = db
               .select({ rankMethod: relatedPapers.rankMethod, embeddingModel: relatedPapers.embeddingModel })
               .from(relatedPapers)
               .where(eq(relatedPapers.paperId, paperId))
               .all();

          const cachedMethods = new Set(allResults.map((r) => r.rankMethod));
          const cachedEmbeddingModel = allResults.find((r) => r.rankMethod === "embedding")?.embeddingModel ?? null;

          // Check if the cached embedding results were produced by the current model
          const currentModel = configManager.getConfig("preferences.defaultEmbeddingModel");
          const currentModelKey = typeof currentModel === "object" ? currentModel?.modelKey : null;
          const embeddingResultsStale = cachedMethods.has("embedding") && cachedEmbeddingModel !== currentModelKey;

          return {
               relatedPapers: results,
               rankMethod: requestedMethod,
               configuredMethod,
               cachedMethods: Array.from(cachedMethods),
               embeddingResultsStale,
          };
     } catch (error) {
          console.error("Error fetching related papers:", error);
          return { error: "Failed to fetch related papers" };
     }
}

// ---------------------------------------------------------------------------
// POST /api/papers/[id]/related-papers
// ---------------------------------------------------------------------------

export async function computeRelatedPapers(id: string) {
     try {
          const paperIdValue = parseInt(id, 10);
          if (isNaN(paperIdValue)) {
               return { error: "Invalid paper ID" };
          }

          // 1. Get paper info from DB
          const paper = db.select().from(papers).where(eq(papers.id, paperIdValue)).get();
          if (!paper) {
               return { error: "Paper not found" };
          }

          // 2. Locate OCR result
          const ocrPath = paper.filePath.replace(/\.pdf$/i, ".ocr.json");
          if (!fs.existsSync(ocrPath)) {
               return { error: "Paper OCR not found. Please ensure paper is processed first." };
          }

          const ocrResult = JSON.parse(fs.readFileSync(ocrPath, "utf-8"));
          const meta = extractDocumentMetadata(ocrResult);
          const pdfTitle = meta.title ?? paper.title ?? paper.fileName;
          const pdfDoi = meta.doi ?? paper.doi ?? undefined;

          // 3. Build the graph
          const graphMethod = configManager.getConfig(
               "personalization.graphConstructionMethod",
               GraphConstructionMethod.Snowball
          );

          const snowballConfig = {
               depth: configManager.getConfig("personalization.snowballDepth"),
               maxPapers: configManager.getConfig("personalization.snowballMaxPapers"),
               bcThreshold: configManager.getConfig("personalization.snowballBcThreshold"),
               ccThreshold: configManager.getConfig("personalization.snowballCcThreshold"),
               // Pass the known S2 ID so Phase 1 (API seed lookup) can be skipped.
               seedPaperS2Id: paper.semanticScholarId ?? undefined,
          };

          const response = await buildRelatedPapersGraph(
               graphMethod,
               pdfTitle,
               pdfDoi,
               snowballConfig
          );

          // Persist a newly resolved S2 ID back to the papers table so future runs skip Phase 1.
          if (response.seedPaperId && !paper.semanticScholarId) {
               db.update(papers)
                    .set({ semanticScholarId: response.seedPaperId })
                    .where(eq(papers.id, paperIdValue))
                    .run();
               console.log(`[computeRelatedPapers] Saved seed S2 ID ${response.seedPaperId} for paper #${paperIdValue}`);
          }

          // 4. Save to database -- replace only rows for this rank method, preserving the other method's results
          db.transaction((tx) => {
               tx.delete(relatedPapers)
                    .where(and(eq(relatedPapers.paperId, paperIdValue), eq(relatedPapers.rankMethod, response.rankMethod)))
                    .run();

               // Refresh source-depth links when recomputing bibliographic results (depth is a
               // graph-structure concept; embedding ranking does not produce meaningful depths).
               if (response.rankMethod !== "embedding") {
                    tx.delete(paperSourceLinks)
                         .where(eq(paperSourceLinks.sourcePaperId, paperIdValue))
                         .run();

                    // Record the seed paper itself at depth 0.
                    if (response.seedPaperId) {
                         tx.insert(paperSourceLinks)
                              .values({ s2PaperId: response.seedPaperId, sourcePaperId: paperIdValue, depth: 0 })
                              .onConflictDoNothing()
                              .run();
                    }
               }

               for (const rp of response.rankedPapers) {
                    // Extract DOI from the URL when it's a doi.org link
                    const doiMatch = rp.url.match(/^https:\/\/doi\.org\/(.+)$/);
                    const doi = doiMatch ? decodeURIComponent(doiMatch[1]) : null;
                    tx.insert(relatedPapers).values({
                         paperId: paperIdValue,
                         title: rp.title,
                         authors: rp.authors || null,
                         year: rp.year || null,
                         venue: rp.venue || null,
                         abstract: rp.snippet || null,
                         doi,
                         semanticScholarId: rp.paperId || null,
                         relevanceScore: rp.score,
                         bcScore: rp.bcScore,
                         ccScore: rp.ccScore,
                         rankMethod: response.rankMethod,
                         embeddingModel: response.embeddingModel ?? null,
                         depth: rp.depth ?? null,
                    }).run();

                    // Record source-depth link for bibliographic results.
                    if (response.rankMethod !== "embedding" && rp.paperId) {
                         tx.insert(paperSourceLinks)
                              .values({ s2PaperId: rp.paperId, sourcePaperId: paperIdValue, depth: rp.depth })
                              .onConflictDoNothing()
                              .run();
                    }
               }
          });

          return {
               success: true,
               pdfTitle,
               rankedPapers: response.rankedPapers,
          };
     } catch (error) {
          console.error("Error computing related papers:", error);
          return { error: "Failed to compute related papers" };
     }
}

// ---------------------------------------------------------------------------
// GET /api/paper-embeddings?folderId=N&limit=N&offset=N
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 10000;

export async function getPaperEmbeddings(folderId?: number, limit?: number, offset?: number) {
     const effectiveLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
     const effectiveOffset = Math.max(0, offset ?? 0);

     try {
          const condition = folderId != null
               ? and(isNotNull(paperChunks.embedding), eq(papers.folderId, folderId))
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
               .limit(effectiveLimit)
               .offset(effectiveOffset)
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

          return { chunks: serialized, total: serialized.length };
     } catch (error) {
          console.error("[paper-embeddings] Failed to fetch", error);
          return { error: "Unable to fetch paper embeddings" };
     }
}

// ---------------------------------------------------------------------------
// DELETE /api/papers/upload/[id] — cancel upload
// ---------------------------------------------------------------------------

export async function cancelPaperUpload(id: string) {
     const paperId = parseInt(id, 10);
     if (isNaN(paperId)) {
          return { error: "Invalid paper ID" };
     }

     // Kill the child process if it is still running
     const entry = activeProcs.get(paperId);
     if (entry) {
          try {
               entry.proc.kill("SIGTERM");
          } catch {
               // Process may have already exited -- ignore
          }
          activeProcs.delete(paperId);

          // Clean up the OCR temp directory
          try {
               fs.rmSync(entry.tempDir, { recursive: true, force: true });
          } catch {
               // Best-effort cleanup
          }
     }

     // Fetch the paper record so we know which library files to remove
     let paperRow: typeof papers.$inferSelect | undefined;
     try {
          paperRow = db.select().from(papers).where(eq(papers.id, paperId)).get();
     } catch {
          // Record may not exist yet if cancellation raced with insertion
     }

     if (paperRow) {
          // Delete the PDF from the library folder
          tryUnlink(paperRow.filePath);

          // Delete the OCR JSON sidecar (e.g. paper.pdf -> paper.ocr.json)
          const ocrJsonPath = paperRow.filePath.replace(/\.pdf$/i, "") + ".ocr.json";
          tryUnlink(ocrJsonPath);

          // Delete the extracted first figure image if present
          tryUnlink(paperRow.firstFigurePath);

          // Remove the DB record entirely
          try {
               db.delete(papers).where(eq(papers.id, paperId)).run();
          } catch {
               // Best-effort
          }
     }

     return { cancelled: true };
}
