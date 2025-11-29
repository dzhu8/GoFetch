"use server";

import crypto from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";

import {
     filterFocusNodes,
     inferFocusSymbolName,
     parseFolderRegistration,
     type ParsedFileAst,
     type SerializedNode,
     type SupportedLanguage,
} from "@/lib/ast";
import folderRegistry, { type FolderRegistration } from "@/server/folderRegistry";
import db from "@/server/db";
import { astFileSnapshots, astNodes, embeddings as embeddingsTable } from "@/server/db/schema";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server";
import type { ModelPreference } from "@/lib/models/modelPreference";
import type { EmbeddingModelClient, MinimalProvider } from "@/lib/models/types";
import { resolveModelPreference } from "@/lib/models/preferenceResolver";
import { clearEmbeddingProgress, embeddingProgressEmitter, updateEmbeddingProgress } from "@/lib/embed/progress";
import folderEvents from "@/server/folderEvents";

const MAX_NODE_SNIPPET = 256;
const EMBEDDING_BATCH_SIZE = 64;

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
                              message: total > 0 ? `Embedding 0/${total} nodes` : "Preparing embeddings...",
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
                              message: total > 0 ? `Embedding ${processed}/${total} nodes` : "Preparing embeddings...",
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
                    message: totalDocuments > 0 ? "Initial embeddings ready" : "No eligible nodes detected",
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

interface EmbedOptions {
     isCancelled?: () => boolean;
     onStart?: (total: number) => void;
     onProgress?: (processed: number, total: number) => void;
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
}

async function embedFolderFromSnapshots(folderName: string, options?: EmbedOptions): Promise<void> {
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
     if (snapshots.length === 0) {
          const folder = folderRegistry.getFolderByName(folderName);
          if (!folder) {
               console.warn(`[embed] Skipping embeddings for ${folderName}; folder not found in registry.`);
               options?.onStart?.(0);
               return;
          }

          console.info(`[embed] No AST snapshots for ${folderName}; creating them now.`);
          const { fileCount } = await ensureAstSnapshots(folder);
          if (fileCount === 0) {
               console.warn(`[embed] No parseable files found for ${folderName}.`);
               options?.onStart?.(0);
               return;
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

          if (snapshots.length === 0) {
               console.warn(`[embed] AST snapshot creation succeeded but no snapshots found for ${folderName}.`);
               options?.onStart?.(0);
               return;
          }
     }

     const snapshotIds = snapshots.map((row) => row.id).filter((id): id is number => typeof id === "number");
     if (snapshotIds.length === 0) {
          options?.onStart?.(0);
          return;
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

     if (nodeRows.length === 0) {
          console.warn(`[embed] No AST nodes found for folder ${folderName}.`);
          options?.onStart?.(0);
          return;
     }

     const documents: NodeDocument[] = [];
     for (const node of nodeRows) {
          const snapshot = snapshotById.get(node.fileId);
          if (!snapshot) {
               continue;
          }

          const nodeMetadata = parseNodeMetadata(node.metadata);
          const symbolName = typeof nodeMetadata.symbolName === "string" ? nodeMetadata.symbolName : null;

          documents.push({
               snapshotId: snapshot.id,
               filePath: snapshot.filePath,
               relativePath: snapshot.relativePath,
               language: snapshot.language,
               nodePath: node.nodePath,
               nodeType: node.type,
               symbolName,
               content: formatNodeDocument(snapshot, node, symbolName),
          });
     }

     if (documents.length === 0) {
          console.warn(`[embed] All AST nodes were filtered out for folder ${folderName}.`);
          options?.onStart?.(0);
          return;
     }

     const preference = resolveEmbeddingPreferenceFromSettings();
     const provider = modelRegistry.getProviderById(preference.providerId);
     if (!provider) {
          throw new Error(`Provider ${preference.providerId} not found; cannot embed AST nodes.`);
     }

     const embeddingModel: EmbeddingModelClient = await provider.provider.loadEmbeddingModel(preference.modelKey);

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
                         nodePath: doc.nodePath,
                         nodeType: doc.nodeType,
                         ...(doc.symbolName ? { symbolName: doc.symbolName } : {}),
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

     // Notify SSE clients that embedding counts have changed
     folderEvents.notifyChange();
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
