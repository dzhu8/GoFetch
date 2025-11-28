"use server";

import crypto from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";

import {
     inferFocusSymbolName,
     parseFolderRegistration,
     type ParsedFileAst,
     type SerializedNode,
     type SupportedLanguage,
} from "@/lib/ast";
import type { FolderRegistration } from "@/server/folderRegistry";
import db from "@/server/db";
import { astFileSnapshots, astNodes, embeddings as embeddingsTable } from "@/server/db/schema";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server";
import type { ModelPreference } from "@/lib/models/modelPreference";
import type { EmbeddingModelClient, MinimalProvider } from "@/lib/models/types";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import { clearEmbeddingProgress, embeddingProgressEmitter, updateEmbeddingProgress } from "@/lib/embed/progress";

const MAX_AST_LINES = 256;
const MAX_SNIPPET_LENGTH = 120;
const EMBEDDING_BATCH_SIZE = 16;

interface ScheduledEmbeddingJob {
     cancelled: boolean;
}

const pendingEmbeds = new Map<string, ScheduledEmbeddingJob>();
const astInFlight = new Map<string, Promise<void>>();

interface SettingsSnapshot {
     preferences?: {
          defaultEmbeddingModel?: ModelPreference | null;
     };
}

export async function ensureFolderPrimed(folder: FolderRegistration): Promise<void> {
     const { fileCount } = await ensureAstSnapshots(folder);
     const hasEmbeddings = folderHasEmbeddings(folder.name);

     if (!hasEmbeddings && fileCount > 0) {
          await embedFolderFromSnapshots(folder.name);
     }
}

export async function scheduleInitialEmbedding(folder: FolderRegistration): Promise<void> {
     cancelInitialEmbedding(folder.name);

     const job: ScheduledEmbeddingJob = { cancelled: false };
     pendingEmbeds.set(folder.name, job);

     updateEmbeddingProgress(folder.name, {
          phase: "parsing",
          totalFiles: 0,
          embeddedFiles: 0,
          message: "Analyzing project files...",
          startedAt: new Date().toISOString(),
     });

     ensureAstSnapshots(folder)
          .then(async ({ fileCount }) => {
               if (job.cancelled) {
                    return;
               }

               embeddingProgressEmitter.emit("ast:complete", { folderName: folder.name, fileCount });

               let totalDocuments = 0;
               await embedFolderFromSnapshots(folder.name, {
                    isCancelled: () => job.cancelled,
                    onStart: (total) => {
                         totalDocuments = total;
                         if (job.cancelled) {
                              return;
                         }
                         updateEmbeddingProgress(folder.name, {
                              phase: "embedding",
                              totalFiles: total,
                              embeddedFiles: 0,
                              message: total > 0 ? `Embedding 0/${total} files` : "Preparing embeddings...",
                         });
                    },
                    onProgress: (processed, total) => {
                         if (job.cancelled) {
                              return;
                         }
                         updateEmbeddingProgress(folder.name, {
                              phase: "embedding",
                              totalFiles: total,
                              embeddedFiles: processed,
                              message: total > 0 ? `Embedding ${processed}/${total} files` : "Preparing embeddings...",
                         });
                    },
               });

               if (job.cancelled) {
                    return;
               }

               updateEmbeddingProgress(folder.name, {
                    phase: "completed",
                    totalFiles: totalDocuments,
                    embeddedFiles: totalDocuments,
                    message: totalDocuments > 0 ? "Initial embeddings ready" : "No eligible files detected",
               });
               embeddingProgressEmitter.emit("embedding:complete", { folderName: folder.name });
          })
          .catch((error) => {
               const message = error instanceof Error ? error.message : String(error);
               updateEmbeddingProgress(folder.name, {
                    phase: "error",
                    error: message,
                    message: "Failed to build embeddings",
               });
               embeddingProgressEmitter.emit("embedding:error", { folderName: folder.name, error: message });
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
          clearEmbeddingProgress(folderName);
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
               const nodeRows = flattenAstNodes(fileAst.ast, fileId, fileAst.language);

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

interface EmbedOptions {
     isCancelled?: () => boolean;
     onStart?: (total: number) => void;
     onProgress?: (processed: number, total: number) => void;
}

async function embedFolderFromSnapshots(folderName: string, options?: EmbedOptions): Promise<void> {
     const astRows = db
          .select({
               id: astFileSnapshots.id,
               filePath: astFileSnapshots.filePath,
               relativePath: astFileSnapshots.relativePath,
               language: astFileSnapshots.language,
               ast: astFileSnapshots.ast,
          })
          .from(astFileSnapshots)
          .where(eq(astFileSnapshots.folderName, folderName))
          .all();

     if (astRows.length === 0) {
          console.warn(`[embed] Skipping embeddings for ${folderName}; no AST snapshots found.`);
          options?.onStart?.(0);
          return;
     }

     const preference = resolveEmbeddingPreferenceFromSettings();

     const provider = modelRegistry.getProviderById(preference.providerId);
     if (!provider) {
          throw new Error(`Provider ${preference.providerId} not found; cannot embed initial snapshots.`);
     }

     const embeddingModel: EmbeddingModelClient = await provider.provider.loadEmbeddingModel(preference.modelKey);
     const documents = astRows.map((row) => ({
          snapshotId: row.id,
          filePath: row.filePath,
          relativePath: row.relativePath,
          language: row.language,
          content: serializeAstForEmbedding(row.relativePath, row.language, row.ast as SerializedNode),
     }));

     deleteExistingInitialEmbeddings(folderName);

     options?.onStart?.(documents.length);
     const rowsToInsert: (typeof embeddingsTable.$inferInsert)[] = [];
     for (let i = 0; i < documents.length; i += EMBEDDING_BATCH_SIZE) {
          const batch = documents.slice(i, i + EMBEDDING_BATCH_SIZE);
          const vectors = await embeddingModel.embedDocuments(batch.map((doc) => doc.content));

          vectors.forEach((vector: number[], index: number) => {
               const doc = batch[index];
               rowsToInsert.push({
                    folderName,
                    filePath: doc.filePath,
                    relativePath: doc.relativePath,
                    fileSnapshotId: doc.snapshotId,
                    content: doc.content,
                    embedding: vectorToBuffer(vector),
                    dim: vector.length,
                    metadata: {
                         stage: "initial",
                         language: doc.language,
                    },
               });
          });

          options?.onProgress?.(Math.min(i + batch.length, documents.length), documents.length);

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
}

function resolveEmbeddingPreferenceFromSettings(): ModelPreference {
     const snapshot = configManager.getAllConfig() as SettingsSnapshot;
     const providers = getMinimalProvidersFromRegistry();
     return resolveModelPreference("embedding", providers, snapshot.preferences?.defaultEmbeddingModel ?? null);
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

     db.delete(embeddingsTable).where(inArray(embeddingsTable.id, initialIds)).run();
}

function flattenAstNodes(
     ast: SerializedNode,
     fileId: number,
     language: SupportedLanguage
): (typeof astNodes.$inferInsert)[] {
     const rows: (typeof astNodes.$inferInsert)[] = [];

     const walk = (node: SerializedNode, path: string): void => {
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

          node.children.forEach((child, index) => {
               const childPath = path ? `${path}.${index}` : `${index}`;
               walk(child, childPath);
          });
     };

     walk(ast, "root");
     return rows;
}

function serializeAstForEmbedding(relativePath: string, language: string, ast: SerializedNode): string {
     const lines: string[] = [];

     const walk = (node: SerializedNode, depth: number): void => {
          if (lines.length >= MAX_AST_LINES) {
               return;
          }

          const indent = " ".repeat(Math.min(depth, 8) * 2);
          const snippet = node.textSnippet ? `: ${truncate(node.textSnippet, MAX_SNIPPET_LENGTH)}` : "";
          lines.push(`${indent}${node.type}${snippet}`.trimEnd());

          for (const child of node.children) {
               if (lines.length >= MAX_AST_LINES) {
                    break;
               }
               walk(child, depth + 1);
          }
     };

     walk(ast, 0);

     return [`Path: ${relativePath}`, `Language: ${language}`, "AST:", ...lines].join("\n");
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
