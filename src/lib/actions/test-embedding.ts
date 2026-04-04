"use server";

import modelRegistry from "@/server/providerRegistry";
import { cosineSimilarity } from "@/lib/utils";

const normalizeInputs = (value: unknown): string[] => {
     if (!Array.isArray(value)) {
          return [];
     }
     return value
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
          .slice(0, 2);
};

export async function testEmbedding(providerId: string, modelKey: string, inputs: string[]) {
     try {
          const normalizedProviderId = typeof providerId === "string" ? providerId.trim() : "";
          const normalizedModelKey = typeof modelKey === "string" ? modelKey.trim() : "";
          const normalizedInputs = normalizeInputs(inputs);

          if (!normalizedProviderId) {
               return { error: "providerId is required" };
          }

          if (!normalizedModelKey) {
               return { error: "modelKey is required" };
          }

          if (normalizedInputs.length !== 2) {
               return { error: "Exactly two input strings are required" };
          }

          const provider = modelRegistry.getProviderById(normalizedProviderId);
          if (!provider) {
               return { error: "Provider not found" };
          }

          const isEmbeddingConfigured = provider.embeddingModels?.some((model) => model.key === normalizedModelKey);
          if (!isEmbeddingConfigured) {
               return { error: "Model is not registered for embeddings" };
          }

          let embeddingClient;
          try {
               embeddingClient = await provider.provider.loadEmbeddingModel(normalizedModelKey);
          } catch (error) {
               console.error(`[test-embedding] Failed to load embedding model ${normalizedModelKey}`, error);
               return { error: "Unable to load embedding model" };
          }

          if (!embeddingClient?.embedDocuments) {
               return { error: "Provider does not support embeddings" };
          }

          let vectors: number[][];
          try {
               vectors = await embeddingClient.embedDocuments(normalizedInputs);
          } catch (error) {
               console.error(`[test-embedding] Embedding request failed for ${normalizedModelKey}`, error);
               return { error: "Embedding request failed" };
          }

          if (!Array.isArray(vectors) || vectors.length < 2) {
               return { error: "Embedding response did not contain two vectors" };
          }

          const similarity = cosineSimilarity(vectors[0] ?? [], vectors[1] ?? []);

          return {
               similarity,
               vectors,
               provider: {
                    id: provider.id,
                    name: provider.name,
               },
               modelKey: normalizedModelKey,
          };
     } catch (error) {
          console.error("[test-embedding] Unexpected error", error);
          return { error: "Unexpected error" };
     }
}
