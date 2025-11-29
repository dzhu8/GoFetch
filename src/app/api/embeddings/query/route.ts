import { NextRequest, NextResponse } from "next/server";
import modelRegistry from "@/server/providerRegistry";
import configManager from "@/server/index";

export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const query = typeof body?.query === "string" ? body.query.trim() : "";

          if (!query) {
               return NextResponse.json({ error: "query is required" }, { status: 400 });
          }

          // Get the default embedding model from config
          const defaultEmbeddingModel = configManager.getConfig("preferences.defaultEmbeddingModel");

          if (!defaultEmbeddingModel) {
               return NextResponse.json(
                    { error: "No default embedding model configured. Please configure one in settings." },
                    { status: 400 }
               );
          }

          const { providerId, modelKey } =
               typeof defaultEmbeddingModel === "object" ? defaultEmbeddingModel : { providerId: null, modelKey: null };

          if (!providerId || !modelKey) {
               return NextResponse.json({ error: "Invalid default embedding model configuration" }, { status: 400 });
          }

          const provider = modelRegistry.getProviderById(providerId);
          if (!provider) {
               return NextResponse.json({ error: `Provider ${providerId} not found` }, { status: 404 });
          }

          const isEmbeddingConfigured = provider.embeddingModels?.some((model) => model.key === modelKey);
          if (!isEmbeddingConfigured) {
               return NextResponse.json({ error: "Model is not registered for embeddings" }, { status: 400 });
          }

          let embeddingClient;
          try {
               embeddingClient = await provider.provider.loadEmbeddingModel(modelKey);
          } catch (error) {
               console.error(`[query-embedding] Failed to load embedding model ${modelKey}`, error);
               return NextResponse.json({ error: "Unable to load embedding model" }, { status: 500 });
          }

          if (!embeddingClient?.embedDocuments) {
               return NextResponse.json({ error: "Provider does not support embeddings" }, { status: 400 });
          }

          let vectors: number[][];
          try {
               vectors = await embeddingClient.embedDocuments([query]);
          } catch (error) {
               console.error(`[query-embedding] Embedding request failed for ${modelKey}`, error);
               return NextResponse.json({ error: "Embedding request failed" }, { status: 500 });
          }

          if (!Array.isArray(vectors) || vectors.length === 0) {
               return NextResponse.json({ error: "Embedding response did not contain a vector" }, { status: 500 });
          }

          return NextResponse.json({
               vector: vectors[0],
               provider: {
                    id: provider.id,
                    name: provider.name,
               },
               modelKey,
          });
     } catch (error) {
          console.error("[query-embedding] Unexpected error", error);
          return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
     }
}
