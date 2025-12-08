"use server";

import crypto from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import {
     filterFocusNodes,
     inferFocusSymbolName,
     parseFolderRegistration,
     type ParsedFileAst,
     type SerializedNode,
     type SupportedLanguage,
} from "@/lib/ast";
import { chunkFolderRegistration, type ChunkedFile, type SupportedTextFormat } from "@/lib/chunk";
import folderRegistry, { type FolderRegistration } from "@/server/folderRegistry";
import db from "@/server/db";
import { astFileSnapshots, astNodes, embeddings as embeddingsTable, textChunkSnapshots } from "@/server/db/schema";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server";
import type { ModelPreference } from "@/lib/models/modelPreference";
import type { EmbeddingModelClient, MinimalProvider } from "@/lib/models/types";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import { clearTaskProgress, taskProgressEmitter, updateTaskProgress } from "@/lib/embed/progress";
import folderEvents from "@/server/folderEvents";

const MAX_NODE_SNIPPET = 256;
const EMBEDDING_BATCH_SIZE = 64;
const SUMMARIZATION_BATCH_SIZE = 8;

interface ScheduledEmbeddingJob {
     cancelled: boolean;
}

const pendingEmbeds = new Map<string, ScheduledEmbeddingJob>();
const astInFlight = new Map<string, Promise<void>>();

interface SettingsSnapshot {
     preferences?: {
          defaultEmbeddingModel?: ModelPreference | null;
          defaultChatModel?: ModelPreference | null;
          embedSummaries?: boolean;
     };
}

export async function ensureFolderPrimed(folder: FolderRegistration): Promise<void> {
     const [astResult, chunkResult] = await Promise.all([ensureAstSnapshots(folder), ensureTextChunkSnapshots(folder)]);
     const hasEmbeddings = folderHasEmbeddings(folder.name);
     const totalSourceCount = astResult.fileCount + chunkResult.chunkCount;

     if (!hasEmbeddings && totalSourceCount > 0) {
          await embedFolderFromSnapshots(folder.name);
     }
}

export async function scheduleInitialEmbedding(folder: FolderRegistration): Promise<void> {
     cancelInitialEmbedding(folder.name);

     const job: ScheduledEmbeddingJob = { cancelled: false };
     pendingEmbeds.set(folder.name, job);

     updateTaskProgress(folder.name, {
          phase: "parsing",
          totalFiles: 0,
          processedFiles: 0,
          message: "Analyzing project files...",
          startedAt: new Date().toISOString(),
     });

     Promise.all([ensureAstSnapshots(folder), ensureTextChunkSnapshots(folder)])
          .then(async ([astResult, chunkResult]) => {
               if (job.cancelled) {
                    return;
               }

               const totalSourceFiles = astResult.fileCount + chunkResult.chunkCount;
               taskProgressEmitter.emit("ast:complete", { folderName: folder.name, fileCount: totalSourceFiles });

               let totalDocuments = 0;
               await embedFolderFromSnapshots(folder.name, {
                    isCancelled: () => job.cancelled,
                    onSummarizationStart: (total) => {
                         totalDocuments = total;
                         if (job.cancelled) {
                              return;
                         }
                         updateTaskProgress(folder.name, {
                              phase: "summarizing",
                              totalFiles: total,
                              processedFiles: 0,
                              totalTokensOutput: 0,
                              message: total > 0 ? `Summarizing 0/${total} snippets` : "Preparing summaries...",
                         });
                    },
                    onSummarizationProgress: (processed, total, totalTokensOutput) => {
                         if (job.cancelled) {
                              return;
                         }
                         updateTaskProgress(folder.name, {
                              phase: "summarizing",
                              totalFiles: total,
                              processedFiles: processed,
                              totalTokensOutput,
                              message:
                                   total > 0 ? `Summarizing ${processed}/${total} snippets` : "Preparing summaries...",
                         });
                    },
                    onEmbeddingStart: (total) => {
                         totalDocuments = total;
                         if (job.cancelled) {
                              return;
                         }
                         updateTaskProgress(folder.name, {
                              phase: "embedding",
                              totalFiles: total,
                              processedFiles: 0,
                              message: total > 0 ? `Embedding 0/${total} documents` : "Preparing embeddings...",
                         });
                    },
                    onEmbeddingProgress: (processed, total) => {
                         if (job.cancelled) {
                              return;
                         }
                         updateTaskProgress(folder.name, {
                              phase: "embedding",
                              totalFiles: total,
                              processedFiles: processed,
                              message:
                                   total > 0 ? `Embedding ${processed}/${total} documents` : "Preparing embeddings...",
                         });
                    },
               });

               if (job.cancelled) {
                    return;
               }

               updateTaskProgress(folder.name, {
                    phase: "completed",
                    totalFiles: totalDocuments,
                    processedFiles: totalDocuments,
                    message: totalDocuments > 0 ? "Initial embeddings ready" : "No eligible documents detected",
               });
               taskProgressEmitter.emit("embedding:complete", { folderName: folder.name });
          })
          .catch((error) => {
               const message = error instanceof Error ? error.message : String(error);
               updateTaskProgress(folder.name, {
                    phase: "error",
                    error: message,
                    message: "Failed to build embeddings",
               });
               taskProgressEmitter.emit("embedding:error", { folderName: folder.name, error: message });
               console.error(`[embed] Failed initial embedding for ${folder.name}:`, error);
          })
          .finally(() => {
               pendingEmbeds.delete(folder.name);
          });
}

export async function cancelInitialEmbedding(folderName: string): Promise<void> {
     const job = pendingEmbeds.get(folderName);
     if (job) {
          job.cancelled = true;
          pendingEmbeds.delete(folderName);
          clearTaskProgress(folderName);
     }
}

interface AstSnapshotResult {
     created: boolean;
     fileCount: number;
}

async function ensureAstSnapshots(folder: FolderRegistration): Promise<AstSnapshotResult> {
     if (folderHasAst(folder.name)) {
          return {
               created: false,
               fileCount: countAstSnapshots(folder.name),
          };
     }

     const inflight = astInFlight.get(folder.name);
     if (inflight) {
          await inflight;
          return {
               created: true,
               fileCount: countAstSnapshots(folder.name),
          };
     }

     let parsedCount = 0;
     const job = (async () => {
          try {
               const parsed = parseFolderRegistration(folder, {
                    includeText: true,
                    maxTextLength: 256,
               });
               parsedCount = parsed.length;
               persistAstSnapshots(folder.name, parsed);
          } finally {
               astInFlight.delete(folder.name);
          }
     })();

     astInFlight.set(folder.name, job);
     await job;
     return {
          created: true,
          fileCount: parsedCount,
     };
}

function folderHasAst(folderName: string): boolean {
     const existing = db
          .select({ id: astFileSnapshots.id })
          .from(astFileSnapshots)
          .where(eq(astFileSnapshots.folderName, folderName))
          .limit(1)
          .get();

     return Boolean(existing);
}

function countAstSnapshots(folderName: string): number {
     const result = db
          .select({ value: sql<number>`count(*)` })
          .from(astFileSnapshots)
          .where(eq(astFileSnapshots.folderName, folderName))
          .get();

     return result?.value ?? 0;
}

function folderHasEmbeddings(folderName: string): boolean {
     const existing = db
          .select({ id: embeddingsTable.id })
          .from(embeddingsTable)
          .where(eq(embeddingsTable.folderName, folderName))
          .limit(1)
          .get();

     return Boolean(existing);
}

function persistAstSnapshots(folderName: string, parsedFiles: ParsedFileAst[]): void {
     db.transaction((tx) => {
          tx.delete(astFileSnapshots).where(eq(astFileSnapshots.folderName, folderName)).run();

          for (const fileAst of parsedFiles) {
               const contentHash = crypto.createHash("sha256").update(JSON.stringify(fileAst.ast)).digest("hex");

               const snapshotResult = tx
                    .insert(astFileSnapshots)
                    .values({
                         folderName,
                         filePath: fileAst.filePath,
                         relativePath: fileAst.relativePath,
                         language: fileAst.language,
                         contentHash,
                         ast: fileAst.ast,
                         diagnostics: fileAst.diagnostics,
                         metadata: {},
                    })
                    .run();

               const fileId = Number(snapshotResult.lastInsertRowid);

               // Filter to focus nodes before flattening
               const focusAst = filterFocusNodes(fileAst.ast, fileAst.language, { requireMultiLine: true });
               const nodeRows = flattenAstNodes(focusAst, fileId, fileAst.language);

               if (nodeRows.length === 0) {
                    continue;
               }

               const chunkSize = 200;
               for (let i = 0; i < nodeRows.length; i += chunkSize) {
                    const chunk = nodeRows.slice(i, i + chunkSize);
                    tx.insert(astNodes).values(chunk).run();
               }
          }

          return undefined;
     });
}

interface TextChunkSnapshotResult {
     created: boolean;
     chunkCount: number;
}

async function ensureTextChunkSnapshots(folder: FolderRegistration): Promise<TextChunkSnapshotResult> {
     if (folderHasTextChunks(folder.name)) {
          return {
               created: false,
               chunkCount: countTextChunkSnapshots(folder.name),
          };
     }

     const chunkedFiles = chunkFolderRegistration(folder);
     let totalChunks = 0;
     for (const file of chunkedFiles) {
          totalChunks += file.chunks.length;
     }

     persistTextChunkSnapshots(folder.name, chunkedFiles);

     return {
          created: true,
          chunkCount: totalChunks,
     };
}

function folderHasTextChunks(folderName: string): boolean {
     const existing = db
          .select({ id: textChunkSnapshots.id })
          .from(textChunkSnapshots)
          .where(eq(textChunkSnapshots.folderName, folderName))
          .limit(1)
          .get();

     return Boolean(existing);
}

function countTextChunkSnapshots(folderName: string): number {
     const result = db
          .select({ value: sql<number>`count(*)` })
          .from(textChunkSnapshots)
          .where(eq(textChunkSnapshots.folderName, folderName))
          .get();

     return result?.value ?? 0;
}

function persistTextChunkSnapshots(folderName: string, chunkedFiles: ChunkedFile[]): void {
     db.transaction((tx) => {
          tx.delete(textChunkSnapshots).where(eq(textChunkSnapshots.folderName, folderName)).run();

          for (const file of chunkedFiles) {
               const fileContentHash = crypto.createHash("sha256").update(file.filePath).digest("hex");

               for (const chunk of file.chunks) {
                    tx.insert(textChunkSnapshots)
                         .values({
                              folderName,
                              filePath: file.filePath,
                              relativePath: file.relativePath,
                              format: file.format,
                              contentHash: fileContentHash,
                              chunkIndex: chunk.index,
                              startIndex: chunk.startIndex,
                              endIndex: chunk.endIndex,
                              startRow: chunk.startPosition.row,
                              startColumn: chunk.startPosition.column,
                              endRow: chunk.endPosition.row,
                              endColumn: chunk.endPosition.column,
                              content: chunk.content,
                              tokenCount: chunk.tokenCount,
                              truncated: chunk.truncated,
                              metadata: {},
                         })
                         .run();
               }
          }

          return undefined;
     });
}

interface EmbedOptions {
     isCancelled?: () => boolean;
     onSummarizationStart?: (total: number) => void;
     onSummarizationProgress?: (processed: number, total: number, totalTokensOutput: number) => void;
     onEmbeddingStart?: (total: number) => void;
     onEmbeddingProgress?: (processed: number, total: number) => void;
}

interface NodeDocument {
     snapshotId: number;
     filePath: string;
     relativePath: string;
     language: string;
     nodePath: string;
     nodeType: string;
     symbolName: string | null;
     content: string;
     originalSnippet: string;
}

interface ChunkDocument {
     chunkId: number;
     filePath: string;
     relativePath: string;
     format: SupportedTextFormat;
     chunkIndex: number;
     label: string;
     content: string;
     originalContent: string;
}

interface SummarizedDocument {
     originalDocument: NodeDocument | ChunkDocument;
     summary: string;
     type: "ast-node" | "text-chunk";
}

async function embedFolderFromSnapshots(folderName: string, options?: EmbedOptions): Promise<void> {
     const folder = folderRegistry.getFolderByName(folderName);

     // Collect AST node documents
     const nodeDocuments = await collectAstNodeDocuments(folderName, folder);

     // Collect text chunk documents
     const chunkDocuments = await collectTextChunkDocuments(folderName, folder);

     const totalDocuments = nodeDocuments.length + chunkDocuments.length;

     if (totalDocuments === 0) {
          console.warn(`[embed] No documents (AST nodes or text chunks) found for folder ${folderName}.`);
          options?.onSummarizationStart?.(0);
          return;
     }

     // Check if we should use summaries or embed code directly
     const shouldEmbedSummaries = getEmbedSummariesPreference();

     // Resolve embedding model (always needed)
     const embeddingPreference = resolveEmbeddingPreferenceFromSettings();
     const embeddingProvider = modelRegistry.getProviderById(embeddingPreference.providerId);
     if (!embeddingProvider) {
          throw new Error(`Provider ${embeddingPreference.providerId} not found; cannot embed documents.`);
     }

     const embeddingModel: EmbeddingModelClient = await embeddingProvider.provider.loadEmbeddingModel(
          embeddingPreference.modelKey
     );

     deleteExistingInitialEmbeddings(folderName);

     if (shouldEmbedSummaries) {
          // Summarization mode: use chat model to generate summaries before embedding
          await embedWithSummarization(folderName, nodeDocuments, chunkDocuments, embeddingModel, options);
     } else {
          // Direct embedding mode: embed code snippets directly (faster)
          await embedDirectly(folderName, nodeDocuments, chunkDocuments, embeddingModel, options);
     }
}

/**
 * Embed documents with summarization using a chat model first.
 * Slower but potentially higher quality search results.
 */
async function embedWithSummarization(
     folderName: string,
     nodeDocuments: NodeDocument[],
     chunkDocuments: ChunkDocument[],
     embeddingModel: EmbeddingModelClient,
     options?: EmbedOptions
): Promise<void> {
     const totalDocuments = nodeDocuments.length + chunkDocuments.length;

     // Resolve chat model for summarization
     const chatPreference = resolveChatPreferenceFromSettings();
     const chatProvider = modelRegistry.getProviderById(chatPreference.providerId);
     if (!chatProvider) {
          throw new Error(`Provider ${chatPreference.providerId} not found; cannot summarize documents.`);
     }

     const chatModel = (await chatProvider.provider.loadChatModel(chatPreference.modelKey)) as BaseChatModel;

     console.log(
          `[embed] Started summarizing folder "${folderName}" using chat model "${chatPreference.modelKey}" from provider "${chatPreference.providerId}"`
     );

     // Phase 1: Summarize all documents
     options?.onSummarizationStart?.(totalDocuments);
     const summarizedDocuments: SummarizedDocument[] = [];
     let summarizedCount = 0;
     let totalTokensOutput = 0;

     // Summarize AST node documents
     for (let i = 0; i < nodeDocuments.length; i += SUMMARIZATION_BATCH_SIZE) {
          const batch = nodeDocuments.slice(i, i + SUMMARIZATION_BATCH_SIZE);
          const result = await summarizeDocumentBatch(chatModel, batch, "ast-node");

          for (let j = 0; j < batch.length; j++) {
               summarizedDocuments.push({
                    originalDocument: batch[j],
                    summary: result.summaries[j],
                    type: "ast-node",
               });
          }

          summarizedCount += batch.length;
          totalTokensOutput += result.tokensOutput;
          options?.onSummarizationProgress?.(summarizedCount, totalDocuments, totalTokensOutput);

          if (options?.isCancelled?.()) {
               return;
          }
     }

     // Summarize text chunk documents
     for (let i = 0; i < chunkDocuments.length; i += SUMMARIZATION_BATCH_SIZE) {
          const batch = chunkDocuments.slice(i, i + SUMMARIZATION_BATCH_SIZE);
          const result = await summarizeDocumentBatch(chatModel, batch, "text-chunk");

          for (let j = 0; j < batch.length; j++) {
               summarizedDocuments.push({
                    originalDocument: batch[j],
                    summary: result.summaries[j],
                    type: "text-chunk",
               });
          }

          summarizedCount += batch.length;
          totalTokensOutput += result.tokensOutput;
          options?.onSummarizationProgress?.(summarizedCount, totalDocuments, totalTokensOutput);

          if (options?.isCancelled?.()) {
               return;
          }
     }

     if (options?.isCancelled?.()) {
          return;
     }

     // Phase 2: Embed all summaries
     options?.onEmbeddingStart?.(summarizedDocuments.length);
     const rowsToInsert: (typeof embeddingsTable.$inferInsert)[] = [];
     let embeddedCount = 0;

     for (let i = 0; i < summarizedDocuments.length; i += EMBEDDING_BATCH_SIZE) {
          const batch = summarizedDocuments.slice(i, i + EMBEDDING_BATCH_SIZE);
          const vectors = await embeddingModel.embedDocuments(batch.map((doc) => doc.summary));

          vectors.forEach((vector: number[], index: number) => {
               const summarized = batch[index];
               const doc = summarized.originalDocument;

               if (summarized.type === "ast-node") {
                    const nodeDoc = doc as NodeDocument;
                    rowsToInsert.push({
                         folderName,
                         filePath: nodeDoc.filePath,
                         relativePath: nodeDoc.relativePath,
                         fileSnapshotId: nodeDoc.snapshotId,
                         content: summarized.summary,
                         embedding: vectorToBuffer(vector),
                         dim: vector.length,
                         metadata: {
                              stage: "initial",
                              type: "ast-node",
                              language: nodeDoc.language,
                              nodePath: nodeDoc.nodePath,
                              nodeType: nodeDoc.nodeType,
                              ...(nodeDoc.symbolName ? { symbolName: nodeDoc.symbolName } : {}),
                              originalSnippet: nodeDoc.originalSnippet,
                         },
                    });
               } else {
                    const chunkDoc = doc as ChunkDocument;
                    rowsToInsert.push({
                         folderName,
                         filePath: chunkDoc.filePath,
                         relativePath: chunkDoc.relativePath,
                         fileSnapshotId: null,
                         content: summarized.summary,
                         embedding: vectorToBuffer(vector),
                         dim: vector.length,
                         metadata: {
                              stage: "initial",
                              type: "text-chunk",
                              format: chunkDoc.format,
                              chunkIndex: chunkDoc.chunkIndex,
                              label: chunkDoc.label,
                              originalContent: chunkDoc.originalContent,
                         },
                    });
               }
          });

          embeddedCount += batch.length;
          options?.onEmbeddingProgress?.(embeddedCount, summarizedDocuments.length);

          if (options?.isCancelled?.()) {
               return;
          }
     }

     if (rowsToInsert.length === 0) {
          return;
     }

     if (options?.isCancelled?.()) {
          return;
     }

     const chunkSize = 50;
     db.transaction((tx) => {
          for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
               const chunk = rowsToInsert.slice(i, i + chunkSize);
               tx.insert(embeddingsTable).values(chunk).run();
          }
          return undefined;
     });

     // Notify SSE clients that embedding counts have changed
     folderEvents.notifyChange();
}

/**
 * Embed documents directly without summarization.
 * Faster but may have lower search quality for complex code.
 */
async function embedDirectly(
     folderName: string,
     nodeDocuments: NodeDocument[],
     chunkDocuments: ChunkDocument[],
     embeddingModel: EmbeddingModelClient,
     options?: EmbedOptions
): Promise<void> {
     const totalDocuments = nodeDocuments.length + chunkDocuments.length;

     console.log(`[embed] Embedding folder "${folderName}" directly (${totalDocuments} documents)`);

     // Skip summarization phase, go straight to embedding
     options?.onEmbeddingStart?.(totalDocuments);
     const rowsToInsert: (typeof embeddingsTable.$inferInsert)[] = [];
     let embeddedCount = 0;

     // Embed AST node documents
     for (let i = 0; i < nodeDocuments.length; i += EMBEDDING_BATCH_SIZE) {
          const batch = nodeDocuments.slice(i, i + EMBEDDING_BATCH_SIZE);
          const vectors = await embeddingModel.embedDocuments(batch.map((doc) => doc.content));

          vectors.forEach((vector: number[], index: number) => {
               const nodeDoc = batch[index];
               rowsToInsert.push({
                    folderName,
                    filePath: nodeDoc.filePath,
                    relativePath: nodeDoc.relativePath,
                    fileSnapshotId: nodeDoc.snapshotId,
                    content: nodeDoc.content,
                    embedding: vectorToBuffer(vector),
                    dim: vector.length,
                    metadata: {
                         stage: "initial",
                         type: "ast-node",
                         language: nodeDoc.language,
                         nodePath: nodeDoc.nodePath,
                         nodeType: nodeDoc.nodeType,
                         ...(nodeDoc.symbolName ? { symbolName: nodeDoc.symbolName } : {}),
                         originalSnippet: nodeDoc.originalSnippet,
                    },
               });
          });

          embeddedCount += batch.length;
          options?.onEmbeddingProgress?.(embeddedCount, totalDocuments);

          if (options?.isCancelled?.()) {
               return;
          }
     }

     // Embed text chunk documents
     for (let i = 0; i < chunkDocuments.length; i += EMBEDDING_BATCH_SIZE) {
          const batch = chunkDocuments.slice(i, i + EMBEDDING_BATCH_SIZE);
          const vectors = await embeddingModel.embedDocuments(batch.map((doc) => doc.content));

          vectors.forEach((vector: number[], index: number) => {
               const chunkDoc = batch[index];
               rowsToInsert.push({
                    folderName,
                    filePath: chunkDoc.filePath,
                    relativePath: chunkDoc.relativePath,
                    fileSnapshotId: null,
                    content: chunkDoc.content,
                    embedding: vectorToBuffer(vector),
                    dim: vector.length,
                    metadata: {
                         stage: "initial",
                         type: "text-chunk",
                         format: chunkDoc.format,
                         chunkIndex: chunkDoc.chunkIndex,
                         label: chunkDoc.label,
                         originalContent: chunkDoc.originalContent,
                    },
               });
          });

          embeddedCount += batch.length;
          options?.onEmbeddingProgress?.(embeddedCount, totalDocuments);

          if (options?.isCancelled?.()) {
               return;
          }
     }

     if (rowsToInsert.length === 0) {
          return;
     }

     if (options?.isCancelled?.()) {
          return;
     }

     const chunkSize = 50;
     db.transaction((tx) => {
          for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
               const chunk = rowsToInsert.slice(i, i + chunkSize);
               tx.insert(embeddingsTable).values(chunk).run();
          }
          return undefined;
     });

     // Notify SSE clients that embedding counts have changed
     folderEvents.notifyChange();
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a code documentation assistant. Your task is to generate concise, searchable summaries of code snippets that will be used for semantic search.

Guidelines:
- The most important guideline is not to include any details that are also true of other code snippets in the file beyond mentioning its high-level purpose (see below point). Focus on what makes this snippet distinct.
- For example, if the folder implements a reranker algorithm, you do not need to say "this computes cosine similarity for a reranking algorithm", only "this computes cosine similarity".  
- Focus on WHAT the code does as well as HOW it does it from a high level (for example, the names of algorithms implemented)
- Include key function/class/variable names
- Mention the purpose, example use cases and if relevant, similar tasks code may be used for
- Keep summaries to fewer than 200 words
- Use natural language that a developer might search for
- Include relevant keywords and concepts
- Do not include code syntax in the summary

Respond with ONLY the summary, no additional text or formatting.`;

interface SummarizationResult {
     summaries: string[];
     tokensOutput: number;
}

async function summarizeDocumentBatch(
     chatModel: BaseChatModel,
     documents: (NodeDocument | ChunkDocument)[],
     type: "ast-node" | "text-chunk"
): Promise<SummarizationResult> {
     const summaries: string[] = [];
     let tokensOutput = 0;

     for (const doc of documents) {
          try {
               const userPrompt =
                    type === "ast-node"
                         ? formatNodeSummarizationPrompt(doc as NodeDocument)
                         : formatChunkSummarizationPrompt(doc as ChunkDocument);

               const response = await chatModel.invoke([
                    new SystemMessage(SUMMARIZATION_SYSTEM_PROMPT),
                    new HumanMessage(userPrompt),
               ]);

               const summary =
                    typeof response.content === "string" ? response.content.trim() : String(response.content);

               summaries.push(summary || doc.content);

               // Track output tokens from response metadata
               const usageMetadata = response.usage_metadata;
               if (usageMetadata && typeof usageMetadata.output_tokens === "number") {
                    tokensOutput += usageMetadata.output_tokens;
               } else if (summary) {
                    // Fallback: estimate tokens as ~4 chars per token
                    tokensOutput += Math.ceil(summary.length / 4);
               }
          } catch (error) {
               console.warn(`[embed] Failed to summarize document, using original content:`, error);
               // Fall back to original content if summarization fails
               summaries.push(doc.content);
          }
     }

     return { summaries, tokensOutput };
}

function formatNodeSummarizationPrompt(doc: NodeDocument): string {
     const lines = [`File: ${doc.relativePath}`, `Language: ${doc.language}`, `Type: ${doc.nodeType}`];

     if (doc.symbolName) {
          lines.push(`Symbol Name: ${doc.symbolName}`);
     }

     lines.push("", "Code:", "```", doc.originalSnippet, "```");

     return lines.join("\n");
}

function formatChunkSummarizationPrompt(doc: ChunkDocument): string {
     return [
          `File: ${doc.relativePath}`,
          `Format: ${doc.format}`,
          "",
          "Content:",
          "```",
          doc.originalContent,
          "```",
     ].join("\n");
}

async function collectAstNodeDocuments(
     folderName: string,
     folder: FolderRegistration | undefined
): Promise<NodeDocument[]> {
     let snapshots = db
          .select({
               id: astFileSnapshots.id,
               filePath: astFileSnapshots.filePath,
               relativePath: astFileSnapshots.relativePath,
               language: astFileSnapshots.language,
          })
          .from(astFileSnapshots)
          .where(eq(astFileSnapshots.folderName, folderName))
          .all();

     // If no AST snapshots exist, try to create them
     if (snapshots.length === 0 && folder) {
          console.info(`[embed] No AST snapshots for ${folderName}; creating them now.`);
          const { fileCount } = await ensureAstSnapshots(folder);
          if (fileCount === 0) {
               return [];
          }

          // Re-fetch snapshots after creation
          snapshots = db
               .select({
                    id: astFileSnapshots.id,
                    filePath: astFileSnapshots.filePath,
                    relativePath: astFileSnapshots.relativePath,
                    language: astFileSnapshots.language,
               })
               .from(astFileSnapshots)
               .where(eq(astFileSnapshots.folderName, folderName))
               .all();
     }

     const snapshotIds = snapshots.map((row) => row.id).filter((id): id is number => typeof id === "number");
     if (snapshotIds.length === 0) {
          return [];
     }

     const snapshotById = new Map<number, (typeof snapshots)[number]>();
     for (const row of snapshots) {
          snapshotById.set(row.id, row);
     }

     const nodeRows = db
          .select({
               id: astNodes.id,
               fileId: astNodes.fileId,
               nodePath: astNodes.nodePath,
               type: astNodes.type,
               textSnippet: astNodes.textSnippet,
               startRow: astNodes.startRow,
               startColumn: astNodes.startColumn,
               endRow: astNodes.endRow,
               endColumn: astNodes.endColumn,
               metadata: astNodes.metadata,
          })
          .from(astNodes)
          .where(inArray(astNodes.fileId, snapshotIds))
          .all();

     const documents: NodeDocument[] = [];
     for (const node of nodeRows) {
          const snapshot = snapshotById.get(node.fileId);
          if (!snapshot) {
               continue;
          }

          const nodeMetadata = parseNodeMetadata(node.metadata);
          const symbolName = typeof nodeMetadata.symbolName === "string" ? nodeMetadata.symbolName : null;
          const originalSnippet = node.textSnippet ? truncate(node.textSnippet, MAX_NODE_SNIPPET) : "";

          documents.push({
               snapshotId: snapshot.id,
               filePath: snapshot.filePath,
               relativePath: snapshot.relativePath,
               language: snapshot.language,
               nodePath: node.nodePath,
               nodeType: node.type,
               symbolName,
               content: formatNodeDocument(snapshot, node, symbolName),
               originalSnippet,
          });
     }

     return documents;
}

async function collectTextChunkDocuments(
     folderName: string,
     folder: FolderRegistration | undefined
): Promise<ChunkDocument[]> {
     let chunks = db
          .select({
               id: textChunkSnapshots.id,
               filePath: textChunkSnapshots.filePath,
               relativePath: textChunkSnapshots.relativePath,
               format: textChunkSnapshots.format,
               chunkIndex: textChunkSnapshots.chunkIndex,
               content: textChunkSnapshots.content,
               startRow: textChunkSnapshots.startRow,
               startColumn: textChunkSnapshots.startColumn,
               endRow: textChunkSnapshots.endRow,
               endColumn: textChunkSnapshots.endColumn,
          })
          .from(textChunkSnapshots)
          .where(eq(textChunkSnapshots.folderName, folderName))
          .all();

     // If no text chunk snapshots exist, try to create them
     if (chunks.length === 0 && folder) {
          console.info(`[embed] No text chunk snapshots for ${folderName}; creating them now.`);
          const { chunkCount } = await ensureTextChunkSnapshots(folder);
          if (chunkCount === 0) {
               return [];
          }

          // Re-fetch chunks after creation
          chunks = db
               .select({
                    id: textChunkSnapshots.id,
                    filePath: textChunkSnapshots.filePath,
                    relativePath: textChunkSnapshots.relativePath,
                    format: textChunkSnapshots.format,
                    chunkIndex: textChunkSnapshots.chunkIndex,
                    content: textChunkSnapshots.content,
                    startRow: textChunkSnapshots.startRow,
                    startColumn: textChunkSnapshots.startColumn,
                    endRow: textChunkSnapshots.endRow,
                    endColumn: textChunkSnapshots.endColumn,
               })
               .from(textChunkSnapshots)
               .where(eq(textChunkSnapshots.folderName, folderName))
               .all();
     }

     const documents: ChunkDocument[] = [];
     for (const chunk of chunks) {
          const formatted = formatChunkDocument({
               relativePath: chunk.relativePath,
               format: chunk.format as SupportedTextFormat,
               chunkIndex: chunk.chunkIndex,
               content: chunk.content,
               startRow: chunk.startRow,
               startColumn: chunk.startColumn,
               endRow: chunk.endRow,
               endColumn: chunk.endColumn,
          });

          documents.push({
               chunkId: chunk.id,
               filePath: chunk.filePath,
               relativePath: chunk.relativePath,
               format: chunk.format as SupportedTextFormat,
               chunkIndex: chunk.chunkIndex,
               label: formatted.label,
               content: formatted.content,
               originalContent: chunk.content,
          });
     }

     return documents;
}

function parseNodeMetadata(value: unknown): Record<string, unknown> {
     if (!value) {
          return {};
     }
     if (typeof value === "object") {
          return value as Record<string, unknown>;
     }
     try {
          return JSON.parse(String(value)) as Record<string, unknown>;
     } catch {
          return {};
     }
}

function formatNodeDocument(
     snapshot: { relativePath: string; language: string },
     node: {
          nodePath: string;
          type: string;
          textSnippet: string | null;
          startRow: number;
          startColumn: number;
          endRow: number;
          endColumn: number;
     },
     symbolName: string | null
): string {
     const snippet = node.textSnippet ? truncate(node.textSnippet, MAX_NODE_SNIPPET) : "<no snippet>";
     const lines = [
          `Path: ${snapshot.relativePath}`,
          `Language: ${snapshot.language}`,
          `Node Path: ${node.nodePath}`,
          `Node Type: ${node.type}`,
     ];

     if (symbolName) {
          lines.push(`Symbol: ${symbolName}`);
     }

     lines.push(
          `Span: (${node.startRow},${node.startColumn})-(${node.endRow},${node.endColumn})`,
          `Snippet: ${snippet}`
     );

     return lines.join("\n");
}

const MAX_CHUNK_LABEL = 50;

function formatChunkDocument(chunk: {
     relativePath: string;
     format: SupportedTextFormat;
     chunkIndex: number;
     content: string;
     startRow: number;
     startColumn: number;
     endRow: number;
     endColumn: number;
}): { label: string; content: string } {
     // Create label from first 50 characters (cleaned up)
     const rawLabel = chunk.content.slice(0, MAX_CHUNK_LABEL).replace(/\s+/g, " ").trim();
     const label = rawLabel.length < chunk.content.length ? `${rawLabel}...` : rawLabel;

     const lines = [
          `Path: ${chunk.relativePath}`,
          `Format: ${chunk.format}`,
          `Chunk: ${chunk.chunkIndex}`,
          `Label: ${label}`,
          `Span: (${chunk.startRow},${chunk.startColumn})-(${chunk.endRow},${chunk.endColumn})`,
          `Content: ${chunk.content}`,
     ];

     return { label, content: lines.join("\n") };
}

function resolveEmbeddingPreferenceFromSettings(): ModelPreference {
     const snapshot = configManager.getAllConfig() as SettingsSnapshot;
     const providers = getMinimalProvidersFromRegistry();
     return resolveModelPreference("embedding", providers, snapshot.preferences?.defaultEmbeddingModel ?? null);
}

function resolveChatPreferenceFromSettings(): ModelPreference {
     const snapshot = configManager.getAllConfig() as SettingsSnapshot;
     const providers = getMinimalProvidersFromRegistry();
     return resolveModelPreference("chat", providers, snapshot.preferences?.defaultChatModel ?? null);
}

function getEmbedSummariesPreference(): boolean {
     const snapshot = configManager.getAllConfig() as SettingsSnapshot;
     return Boolean(snapshot.preferences?.embedSummaries);
}

function getMinimalProvidersFromRegistry(): MinimalProvider[] {
     return modelRegistry.getProviders().map((provider) => ({
          id: provider.id,
          name: provider.name,
          type: provider.type,
          chatModels: provider.chatModels ?? [],
          embeddingModels: provider.embeddingModels ?? [],
     }));
}

function deleteExistingInitialEmbeddings(folderName: string): void {
     const existing = db
          .select({ id: embeddingsTable.id, metadata: embeddingsTable.metadata })
          .from(embeddingsTable)
          .where(eq(embeddingsTable.folderName, folderName))
          .all();

     const initialIds = existing
          .filter((row) => (row.metadata as Record<string, unknown>)?.stage === "initial")
          .map((row) => row.id);

     if (initialIds.length === 0) {
          return;
     }

     // Batch delete to avoid SQLite variable limit
     const batchSize = 500;
     for (let i = 0; i < initialIds.length; i += batchSize) {
          const batch = initialIds.slice(i, i + batchSize);
          db.delete(embeddingsTable).where(inArray(embeddingsTable.id, batch)).run();
     }
}

function flattenAstNodes(
     ast: SerializedNode,
     fileId: number,
     language: SupportedLanguage
): (typeof astNodes.$inferInsert)[] {
     const rows: (typeof astNodes.$inferInsert)[] = [];

     // Only embed top-level focus nodes (direct children of the root).
     // Do NOT recurse into nested focus nodes (e.g., methods inside classes,
     // inner functions inside functions) to avoid embedding thousands of
     // nested arrow functions, callbacks, etc. that bloat the embedding store.
     // The text snippet of a focus node already captures its full content,
     // making nested embeddings redundant.
     for (let index = 0; index < ast.children.length; index++) {
          const node = ast.children[index];
          const path = `root.${index}`;
          const symbolName = inferFocusSymbolName(language, node);
          const metadata = {
               truncatedByDepth: node.truncatedByDepth ?? false,
               truncatedByChildLimit: node.truncatedByChildLimit ?? false,
          } as Record<string, unknown>;

          if (symbolName) {
               metadata.symbolName = symbolName;
          }

          rows.push({
               fileId,
               nodePath: path,
               type: node.type,
               named: node.named,
               hasError: node.hasError,
               startIndex: node.startIndex,
               endIndex: node.endIndex,
               startRow: node.startPosition.row,
               startColumn: node.startPosition.column,
               endRow: node.endPosition.row,
               endColumn: node.endPosition.column,
               childCount: node.childCount,
               textSnippet: node.textSnippet ?? null,
               metadata,
          });
     }

     return rows;
}

function truncate(value: string, maxLength: number): string {
     if (value.length <= maxLength) {
          return value;
     }
     return `${value.slice(0, maxLength)}...`;
}

function vectorToBuffer(vector: number[]): Buffer {
     const arr = Float32Array.from(vector);
     return Buffer.from(arr.buffer);
}
