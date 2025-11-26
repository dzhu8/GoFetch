import { NextRequest, NextResponse } from "next/server";
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

export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const providerId = typeof body?.providerId === "string" ? body.providerId.trim() : "";
          const modelKey = typeof body?.modelKey === "string" ? body.modelKey.trim() : "";
          const inputs = normalizeInputs(body?.inputs);

          if (!providerId) {
               return NextResponse.json({ error: "providerId is required" }, { status: 400 });
          }

          if (!modelKey) {
               return NextResponse.json({ error: "modelKey is required" }, { status: 400 });
          }

          if (inputs.length !== 2) {
               return NextResponse.json({ error: "Exactly two input strings are required" }, { status: 400 });
          }

          const provider = modelRegistry.getProviderById(providerId);
          if (!provider) {
               return NextResponse.json({ error: "Provider not found" }, { status: 404 });
          }

          const isEmbeddingConfigured = provider.embeddingModels?.some((model) => model.key === modelKey);
          if (!isEmbeddingConfigured) {
               return NextResponse.json({ error: "Model is not registered for embeddings" }, { status: 400 });
          }

          let embeddingClient;
          try {
               embeddingClient = await provider.provider.loadEmbeddingModel(modelKey);
          } catch (error) {
               console.error(`[test-embedding] Failed to load embedding model ${modelKey}`, error);
               return NextResponse.json({ error: "Unable to load embedding model" }, { status: 500 });
          }

          if (!embeddingClient?.embedDocuments) {
               return NextResponse.json({ error: "Provider does not support embeddings" }, { status: 400 });
          }

          let vectors: number[][];
          try {
               vectors = await embeddingClient.embedDocuments(inputs);
          } catch (error) {
               console.error(`[test-embedding] Embedding request failed for ${modelKey}`, error);
               return NextResponse.json({ error: "Embedding request failed" }, { status: 500 });
          }

          if (!Array.isArray(vectors) || vectors.length < 2) {
               return NextResponse.json({ error: "Embedding response did not contain two vectors" }, { status: 500 });
          }

          const similarity = cosineSimilarity(vectors[0] ?? [], vectors[1] ?? []);

          return NextResponse.json({
               similarity,
               vectors,
               provider: {
                    id: provider.id,
                    name: provider.name,
               },
               modelKey,
          });
     } catch (error) {
          console.error("[test-embedding] Unexpected error", error);
          return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
     }
}
