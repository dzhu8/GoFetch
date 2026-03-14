import fs from "node:fs/promises";
import path from "node:path";
import db from "@/server/db";
import { paperChunks, papers } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import modelRegistry from "@/server/providerRegistry";
import { updateTaskProgress, taskProgressEmitter } from "@/lib/embed/progress";
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
               chunks.push({
                    sectionType: section.type,
                    content: chunkLines.join("\n"),
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

const embeddingQueue: { paperId: number; folderName: string }[] = [];
let isProcessingQueue = false;

async function processEmbeddingQueue() {
     if (isProcessingQueue || embeddingQueue.length === 0) return;
     isProcessingQueue = true;

     while (embeddingQueue.length > 0) {
          const { paperId, folderName } = embeddingQueue.shift()!;
          try {
               await embedPaperChunks(paperId, folderName);
          } catch (error) {
               console.error(`[embed] Failed to embed paper ${paperId}:`, error);
               updateTaskProgress(folderName, {
                    phase: "error",
                    error: error instanceof Error ? error.message : String(error),
                    message: `Failed to embed paper ${paperId}`
               });
          }
     }

     isProcessingQueue = false;
}

export function queuePaperEmbedding(paperId: number, folderName: string) {
     embeddingQueue.push({ paperId, folderName });
     processEmbeddingQueue();
}

export async function embedPaperChunks(paperId: number, folderName: string) {
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
          phase: "embedding",
          totalFiles: chunks.length,
          processedFiles: 0,
          message: `Embedding paper chunks (0/${chunks.length})...`
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

          updateTaskProgress(folderName, {
               processedFiles: i + batch.length,
               message: `Embedding paper chunks (${i + batch.length}/${chunks.length})...`
          });
     }

     updateTaskProgress(folderName, {
          phase: "completed",
          message: `Finished embedding paper with ${chunks.length} chunks.`
     });
}
