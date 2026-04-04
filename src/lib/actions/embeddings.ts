"use server";

import type { Buffer } from "node:buffer";
import { eq, sql } from "drizzle-orm";

import db from "@/server/db";
import { embeddings } from "@/server/db/schema";
import folderEvents from "@/server/folderEvents";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server/index";

const toVector = (buffer: Buffer, dim: number) => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, dim);
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
          const whereClause = eq(embeddings.folderName, folderName);

          // Get total count
          const countResult = db
               .select({ count: sql<number>`count(*)` })
               .from(embeddings)
               .where(whereClause)
               .get();
          const total = countResult?.count ?? 0;

          const rows = db
               .select({
                    id: embeddings.id,
                    filePath: embeddings.filePath,
                    relativePath: embeddings.relativePath,
                    content: embeddings.content,
                    metadata: embeddings.metadata,
                    embedding: embeddings.embedding,
                    dim: embeddings.dim,
               })
               .from(embeddings)
               .where(whereClause)
               .limit(resolvedLimit)
               .offset(resolvedOffset)
               .all();

          const serialized = rows.map((row) => ({
               id: row.id,
               filePath: row.filePath,
               relativePath: row.relativePath,
               content: row.content,
               metadata: row.metadata ?? {},
               vector: toVector(row.embedding as Buffer, row.dim),
          }));

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
          const { changes } = db.delete(embeddings).where(eq(embeddings.folderName, folderName)).run();

          // Notify SSE clients that embedding counts have changed
          folderEvents.notifyChange();

          return { deleted: changes ?? 0 };
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
