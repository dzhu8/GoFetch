"use server";

import type { Buffer } from "node:buffer";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import db from "@/server/db";
import { libraryFolders, papers, paperChunks } from "@/server/db/schema";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server/index";

const toVector = (buffer: Buffer): number[] => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
     return Array.from(floatView);
};

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export async function getEmbeddings(folderName: string, limit?: number, offset?: number) {
     if (!folderName) {
          return { error: "folderName is required" };
     }

     const resolvedLimit = Math.min(Math.max(1, limit ?? DEFAULT_LIMIT), MAX_LIMIT);
     const resolvedOffset = Math.max(0, offset ?? 0);

     try {
          const folder = db
               .select({ id: libraryFolders.id })
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();

          if (!folder) {
               return { embeddings: [], total: 0, limit: resolvedLimit, offset: resolvedOffset, hasMore: false };
          }

          const whereClause = and(
               eq(papers.folderId, folder.id),
               isNotNull(paperChunks.embedding),
          );

          // Get total count
          const countResult = db
               .select({ count: sql<number>`count(*)` })
               .from(paperChunks)
               .innerJoin(papers, eq(paperChunks.paperId, papers.id))
               .where(whereClause)
               .get();
          const total = countResult?.count ?? 0;

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
               .where(whereClause)
               .limit(resolvedLimit)
               .offset(resolvedOffset)
               .all();

          const serialized = rows
               .filter((row) => row.embedding)
               .map((row) => ({
                    id: row.id,
                    relativePath: row.fileName,
                    content: row.content,
                    metadata: {
                         paperId: row.paperId,
                         sectionType: row.sectionType,
                         chunkIndex: row.chunkIndex,
                         title: row.title,
                    },
                    vector: toVector(row.embedding as Buffer),
               }))
               .filter((row) => row.vector.length > 0);

          return {
               embeddings: serialized,
               total,
               limit: resolvedLimit,
               offset: resolvedOffset,
               hasMore: resolvedOffset + rows.length < total,
          };
     } catch (error) {
          console.error("[embeddings] Failed to fetch embeddings", error);
          return { error: "Unable to fetch embeddings" };
     }
}

export async function deleteEmbeddings(folderName: string) {
     if (!folderName) {
          return { error: "folderName is required" };
     }

     try {
          const folder = db
               .select({ id: libraryFolders.id })
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();

          if (!folder) {
               return { deleted: 0 };
          }

          // Get all paper IDs in this folder
          const folderPapers = db
               .select({ id: papers.id })
               .from(papers)
               .where(eq(papers.folderId, folder.id))
               .all();

          if (folderPapers.length === 0) {
               return { deleted: 0 };
          }

          // Null out embeddings on all chunks for these papers
          let deleted = 0;
          for (const paper of folderPapers) {
               const { changes } = db
                    .update(paperChunks)
                    .set({ embedding: null })
                    .where(and(
                         eq(paperChunks.paperId, paper.id),
                         isNotNull(paperChunks.embedding),
                    ))
                    .run();
               deleted += changes;
          }

          return { deleted };
     } catch (error) {
          console.error("[embeddings] Failed to delete embeddings", error);
          return { error: "Unable to delete embeddings" };
     }
}

export async function embedQuery(query: string) {
     try {
          const trimmedQuery = typeof query === "string" ? query.trim() : "";

          if (!trimmedQuery) {
               return { error: "query is required" };
          }

          // Get the default embedding model from config
          const defaultEmbeddingModel = configManager.getConfig("preferences.defaultEmbeddingModel");

          if (!defaultEmbeddingModel) {
               return { error: "No default embedding model configured. Please configure one in settings." };
          }

          const { providerId, modelKey } =
               typeof defaultEmbeddingModel === "object" ? defaultEmbeddingModel : { providerId: null, modelKey: null };

          if (!providerId || !modelKey) {
               return { error: "Invalid default embedding model configuration" };
          }

          const provider = modelRegistry.getProviderById(providerId);
          if (!provider) {
               return { error: `Provider ${providerId} not found` };
          }

          const isEmbeddingConfigured = provider.embeddingModels?.some((model) => model.key === modelKey);
          if (!isEmbeddingConfigured) {
               return { error: "Model is not registered for embeddings" };
          }

          let embeddingClient;
          try {
               embeddingClient = await provider.provider.loadEmbeddingModel(modelKey);
          } catch (error) {
               console.error(`[query-embedding] Failed to load embedding model ${modelKey}`, error);
               return { error: "Unable to load embedding model" };
          }

          if (!embeddingClient?.embedDocuments) {
               return { error: "Provider does not support embeddings" };
          }

          let vectors: number[][];
          try {
               vectors = await embeddingClient.embedDocuments([trimmedQuery]);
          } catch (error) {
               console.error(`[query-embedding] Embedding request failed for ${modelKey}`, error);
               return { error: "Embedding request failed" };
          }

          if (!Array.isArray(vectors) || vectors.length === 0) {
               return { error: "Embedding response did not contain a vector" };
          }

          return {
               vector: vectors[0],
               provider: {
                    id: provider.id,
                    name: provider.name,
               },
               modelKey,
          };
     } catch (error) {
          console.error("[query-embedding] Unexpected error", error);
          return { error: "Unexpected error" };
     }
}
