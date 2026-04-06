import fs from "node:fs/promises";
import path from "node:path";
import db from "@/server/db";
import { paperChunks, papers, paperSections } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import modelRegistry from "@/server/providerRegistry";
import { updateTaskProgress } from "@/lib/embed/progress";
import configManager from "@/server";
import { MinimalProvider } from "@/lib/models/types";
import { ModelPreference } from "@/lib/models/modelPreference";

interface SettingsSnapshot {
     preferences?: {
          defaultEmbeddingModel?: ModelPreference | null;
          defaultChatModel?: ModelPreference | null;
          embedSummaries?: boolean;
     };
}

export interface OCRBlock {
     block_label: string;
     block_content: string;
     [key: string]: any;
}

export interface OCRPage {
     page: number;
     data: {
          parsing_res_list: OCRBlock[];
          [key: string]: any;
     };
}

export interface OCRDocument {
     source: string;
     pages: OCRPage[];
}

const ALLOWED_LABELS = [
     "paragraph_title",
     "abstract",
     "figure_title",
     "table",
     "display_formula",
     "text"
];

const CHUNK_SIZE_LINES = 1000;

function isUninformativeChunk(content: string): boolean {
     const trimmed = content.trim();

     // Exclude chunks less than 100 characters
     if (trimmed.length < 100) return true;

     // Exclude chunks that are only whitespace or have no alphanumeric text
     // This handles the "strange case where there may be many '\' type characters"
     if (!/[a-zA-Z0-9]/.test(trimmed)) return true;

     // Exclude DOI strings (heuristic: contains 'doi.org' or starts with '10.' followed by numbers/slash)
     const doiPattern = /^(https?:\/\/)?(www\.)?doi\.org\/[^\s]+$|^10\.\d{4,9}\/[-._;()/:A-Z0-9]+$/i;
     if (doiPattern.test(trimmed)) return true;

     // Exclude boilerplate keywords
     const boilerplateKeywords = [
          "competing interests",
          "acknowledgements",
          "author contributions",
          "check for updates",
          "nature portfolio reporting summaries",
          "additional references",
          "data availability",
          "code availability",
          "peer review information",
          "publisher's note",
          "https://doi.org",
          "should be addressed to",
          "open access",
          "creative commons",
          "reporting summary"
     ];
     if (boilerplateKeywords.some(kw => trimmed.toLowerCase().includes(kw))) return true;

     // Exclude "Published" followed by a date in any form
     // Standard patterns: Published: Dec 2024, Published 12/20/2024, Published January 1, 2025, etc.
     const publishedDatePattern = /published\s*[:\s]\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[a-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[a-z]+\s+\d{4})/i;
     if (publishedDatePattern.test(trimmed)) return true;

     // Exclude comma-separated lists containing "motifs" consisting of two-three strings and $ ^{n} $
     // Example: "Marco Becilli, Markus Metzler, Claudia Bracaglia. ¹⁵These authors contributed equally"
     // Or affiliations like "Dept of Hematology, Rome, Italy. ¹Department..."
     // Pattern: look for the LaTeX-style superscript $ ^{n} $ or superscript characters
     const superscriptMotifPattern = /([A-Z][a-z]+[^,.]+){1,3}([,.]\s*)?(\$?\s?\^\{\d+\}\s?\$?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+)/;
     if (superscriptMotifPattern.test(trimmed)) {
          // Check if it's a list-like structure (multiple commas/periods followed by these motifs)
          const matches = trimmed.match(new RegExp(superscriptMotifPattern, 'g'));
          if (matches && matches.length >= 2) return true;
     }

     return false;
}

export async function processPaperOCR(paperId: number, ocrPath: string) {
     const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
     if (!paper) throw new Error(`Paper ${paperId} not found`);

     const content = await fs.readFile(ocrPath, "utf-8");
     const ocrData: OCRDocument = JSON.parse(content);

     const sections: { type: string; content: string }[] = [];
     let currentParagraphTitle = "";

     for (const page of ocrData.pages) {
          for (const block of page.data.parsing_res_list) {
               const label = block.block_label;
               
               if (!ALLOWED_LABELS.includes(label)) continue;

               if (label === "paragraph_title") {
                    currentParagraphTitle = block.block_content;
                    continue;
               }

               if (label === "text") {
                    const combinedContent = currentParagraphTitle 
                         ? `${currentParagraphTitle}\n${block.block_content}`
                         : block.block_content;
                    sections.push({ type: "paragraph_title", content: combinedContent });
                    currentParagraphTitle = ""; // Reset after using
               } else {
                    sections.push({ type: label, content: block.block_content });
               }
          }
     }

     const chunks: { sectionType: string; content: string; chunkIndex: number }[] = [];
     for (const section of sections) {
          const lines = section.content.split("\n");
          for (let i = 0; i < lines.length; i += CHUNK_SIZE_LINES) {
               const chunkLines = lines.slice(i, i + CHUNK_SIZE_LINES);
               const content = chunkLines.join("\n");
               
               if (isUninformativeChunk(content)) continue;

               chunks.push({
                    sectionType: section.type,
                    content,
                    chunkIndex: Math.floor(i / CHUNK_SIZE_LINES)
               });
          }
     }

     // Store chunks without embeddings first
     db.transaction((tx) => {
          tx.delete(paperChunks).where(eq(paperChunks.paperId, paperId)).run();
          for (const chunk of chunks) {
               tx.insert(paperChunks).values({
                    paperId,
                    sectionType: chunk.sectionType,
                    chunkIndex: chunk.chunkIndex,
                    content: chunk.content,
               }).run();
          }
     });

     return chunks;
}

// ---- Per-folder paper-level progress tracking ----
// totalFiles / processedFiles.
// Use globalThis to survive Next.js module re-instantiation.
const GLOBAL_KEY_TOTAL = Symbol.for("gofetch.folderTotalPapers");
const GLOBAL_KEY_PROCESSED = Symbol.for("gofetch.folderProcessedPapers");
const GLOBAL_KEY_QUEUE = Symbol.for("gofetch.embeddingQueue");
const GLOBAL_KEY_PROCESSING = Symbol.for("gofetch.isProcessingQueue");

const g = globalThis as Record<symbol, unknown>;
if (!g[GLOBAL_KEY_TOTAL]) g[GLOBAL_KEY_TOTAL] = new Map<string, number>();
if (!g[GLOBAL_KEY_PROCESSED]) g[GLOBAL_KEY_PROCESSED] = new Map<string, number>();
if (!g[GLOBAL_KEY_QUEUE]) g[GLOBAL_KEY_QUEUE] = [] as { paperId: number; folderName: string; paperName: string }[];
if (g[GLOBAL_KEY_PROCESSING] === undefined) g[GLOBAL_KEY_PROCESSING] = false;

const folderTotalPapers = g[GLOBAL_KEY_TOTAL] as Map<string, number>;
const folderProcessedPapers = g[GLOBAL_KEY_PROCESSED] as Map<string, number>;
const embeddingQueue = g[GLOBAL_KEY_QUEUE] as { paperId: number; folderName: string; paperName: string }[];

async function processEmbeddingQueue() {
     if (g[GLOBAL_KEY_PROCESSING] || embeddingQueue.length === 0) return;
     g[GLOBAL_KEY_PROCESSING] = true;

     while (embeddingQueue.length > 0) {
          const { paperId, folderName, paperName } = embeddingQueue.shift()!;

          try {
               await embedPaperChunks(paperId, folderName, paperName);
          } catch (error) {
               const errMsg = error instanceof Error ? error.message : String(error);
               console.error(`[embed] Failed to embed paper ${paperId}:`, error);

               // Mark the paper as "error" in the database so it won't be
               // re-triggered automatically on folder open.
               db.update(papers)
                    .set({ status: "error", updatedAt: new Date().toISOString() })
                    .where(eq(papers.id, paperId))
                    .run();

               updateTaskProgress(folderName, {
                    phase: "error",
                    error: errMsg,
                    message: `Failed to embed "${paperName}"`
               });
               // Keep going with remaining papers — don't reset counters
               continue;
          }

          // Increment processed count for this folder
          const processed = (folderProcessedPapers.get(folderName) ?? 0) + 1;
          folderProcessedPapers.set(folderName, processed);
          const total = folderTotalPapers.get(folderName) ?? processed;

          if (processed >= total) {
               // All papers done — emit completed and reset counters
               folderTotalPapers.delete(folderName);
               folderProcessedPapers.delete(folderName);
               updateTaskProgress(folderName, {
                    phase: "completed",
                    totalFiles: total,
                    processedFiles: total,
                    message: `All ${total} paper${total !== 1 ? "s" : ""} embedded.`,
               });
          } else {
               // More papers remaining
               updateTaskProgress(folderName, {
                    phase: "embedding",
                    totalFiles: total,
                    processedFiles: processed,
                    message: `Embedded ${processed} / ${total} papers...`,
               });
          }
     }

     g[GLOBAL_KEY_PROCESSING] = false;
}

export function queuePaperEmbedding(paperId: number, folderName: string, paperName: string = "Unknown paper") {
     // Increment total queued for this folder
     const newTotal = (folderTotalPapers.get(folderName) ?? 0) + 1;
     folderTotalPapers.set(folderName, newTotal);
     const processed = folderProcessedPapers.get(folderName) ?? 0;

     // Immediately update progress so any SSE that opens afterwards sees "embedding"
     updateTaskProgress(folderName, {
          phase: "embedding",
          totalFiles: newTotal,
          processedFiles: processed,
          message: `Embedding papers (${processed}/${newTotal})...`,
     });

     embeddingQueue.push({ paperId, folderName, paperName });
     processEmbeddingQueue();
}

export async function embedPaperChunks(paperId: number, folderName: string, paperName: string = "Unknown paper") {
     const chunks = db.select().from(paperChunks).where(eq(paperChunks.paperId, paperId)).all();
     if (chunks.length === 0) return;

     const snapshot = configManager.getAllConfig() as SettingsSnapshot;
     const providers = modelRegistry.getProviders().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          chatModels: p.chatModels ?? [],
          embeddingModels: p.embeddingModels ?? [],
          ocrModels: p.ocrModels ?? [],
     })) as MinimalProvider[];

     const preference = resolveModelPreference(
          "embedding",
          providers,
          snapshot.preferences?.defaultEmbeddingModel
     );

     const provider = modelRegistry.getProviderById(preference.providerId);
     if (!provider) throw new Error(`Provider ${preference.providerId} not found`);
     
     const model = await provider.provider.loadEmbeddingModel(preference.modelKey);

     updateTaskProgress(folderName, {
          message: `Embedding "${paperName}" (0/${chunks.length} chunks)...`
     });

     // Embed in batches
     const BATCH_SIZE = 10;
     for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const batch = chunks.slice(i, i + BATCH_SIZE);
          const embeddings = await model.embedDocuments(batch.map(c => c.content));
          
          db.transaction((tx) => {
               for (let j = 0; j < batch.length; j++) {
                    const embeddingArray = Array.from(embeddings[j]);
                    const buffer = Buffer.from(new Float32Array(embeddingArray).buffer);
                    tx.update(paperChunks)
                      .set({ embedding: buffer })
                      .where(eq(paperChunks.id, batch[j].id))
                      .run();
               }
          });

          const processed = i + batch.length;
          updateTaskProgress(folderName, {
               message: `Embedding "${paperName}" (${processed}/${chunks.length} chunks)...`
          });
     }
}

// ── Paper reconstruction queue ──────────────────────────────────────────────
// Runs PaperReconstructor.reconstructSections() in the background after upload,
// persisting results to the paperSections table. Independent of the embedding queue.

interface ReconstructionJob {
     paperId: number;
     folderName: string;
     paperName: string;
     ocrJsonPath: string;
     pdfPath: string;
}

const GLOBAL_KEY_RECON_QUEUE = Symbol.for("gofetch.reconstructionQueue");
const GLOBAL_KEY_RECON_PROCESSING = Symbol.for("gofetch.isProcessingReconQueue");

if (!g[GLOBAL_KEY_RECON_QUEUE]) g[GLOBAL_KEY_RECON_QUEUE] = [] as ReconstructionJob[];
if (g[GLOBAL_KEY_RECON_PROCESSING] === undefined) g[GLOBAL_KEY_RECON_PROCESSING] = false;

const reconstructionQueue = g[GLOBAL_KEY_RECON_QUEUE] as ReconstructionJob[];

async function processReconstructionQueue() {
     if (g[GLOBAL_KEY_RECON_PROCESSING] || reconstructionQueue.length === 0) return;
     g[GLOBAL_KEY_RECON_PROCESSING] = true;

     // Lazy import to avoid circular dependency
     const { PaperReconstructor } = await import("@/lib/paperReconstructor");

     while (reconstructionQueue.length > 0) {
          const job = reconstructionQueue.shift()!;
          console.log(`[PaperReconstruction] Processing paper ${job.paperId}: ${job.paperName}`);

          try {
               const ocrRaw = await fs.readFile(job.ocrJsonPath, "utf-8");
               const ocrDoc: OCRDocument = JSON.parse(ocrRaw);
               const reconstructor = new PaperReconstructor(ocrDoc, job.pdfPath, job.paperId);
               const sections = await reconstructor.reconstructSections();

               type SectionType = "main_text" | "methods" | "references" | "figures";
               const rows: { paperId: number; sectionType: SectionType; content: string }[] = [
                    { paperId: job.paperId, sectionType: "main_text", content: sections.mainText },
                    { paperId: job.paperId, sectionType: "references", content: sections.references },
                    { paperId: job.paperId, sectionType: "figures", content: JSON.stringify(sections.figures) },
               ];
               if (sections.methods) {
                    rows.push({ paperId: job.paperId, sectionType: "methods", content: sections.methods });
               }

               db.transaction((tx) => {
                    for (const row of rows) {
                         tx.insert(paperSections)
                              .values(row)
                              .onConflictDoNothing()
                              .run();
                    }
               });

               console.log(`[PaperReconstruction] Completed paper ${job.paperId}: ${job.paperName}`);
          } catch (err) {
               console.error(`[PaperReconstruction] Failed paper ${job.paperId}:`, err);
               // Non-fatal — don't affect paper status, just log and continue
          }
     }

     g[GLOBAL_KEY_RECON_PROCESSING] = false;
}

export function queuePaperReconstruction(
     paperId: number,
     folderName: string,
     paperName: string,
     ocrJsonPath: string,
     pdfPath: string,
) {
     reconstructionQueue.push({ paperId, folderName, paperName, ocrJsonPath, pdfPath });
     processReconstructionQueue();
}
