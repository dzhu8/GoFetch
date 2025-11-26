import { NextRequest, NextResponse } from "next/server";
import modelRegistry from "@/server/providerRegistry";
import type { Model } from "@/lib/models/types";
import type { ProviderModelMetadata } from "@/lib/models/providers/BaseModelProvider";

const formatSize = (sizeGB?: number) => {
     if (typeof sizeGB !== "number" || Number.isNaN(sizeGB) || sizeGB <= 0) {
          return undefined;
     }
     if (sizeGB >= 1) {
          return `${sizeGB.toFixed(1)} GB`;
     }
     return `${(sizeGB * 1024).toFixed(0)} MB`;
};

const formatParameters = (parameters?: number) => {
     if (typeof parameters !== "number" || Number.isNaN(parameters) || parameters <= 0) {
          return undefined;
     }

     if (parameters >= 1_000_000_000) {
          return `${(parameters / 1_000_000_000).toFixed(1)}B`;
     }

     if (parameters >= 1_000_000) {
          return `${(parameters / 1_000_000).toFixed(0)}M`;
     }

     return parameters.toLocaleString();
};

export const GET = async (_req: NextRequest, { params }: { params: { id: string } }) => {
     const id = params?.id;

     if (!id) {
          return NextResponse.json({ message: "Provider id is required" }, { status: 400 });
     }

     const registered = modelRegistry.getProviderById(id);

     if (!registered) {
          return NextResponse.json({ message: "Provider not found" }, { status: 404 });
     }

     let modelList;

     try {
          modelList = await registered.provider.getModelList();
     } catch (error) {
          console.error(`[providers/${id}/models] Failed to load model list`, error);
          modelList = {
               chat: registered.chatModels ?? [],
               embedding: registered.embeddingModels ?? [],
          };
     }

     const metadataCache = new Map<string, ProviderModelMetadata | undefined>();

     const fetchMetadata = async (modelKey: string) => {
          if (metadataCache.has(modelKey)) {
               return metadataCache.get(modelKey);
          }

          let metadata = registered.provider.getModelMetadata?.(modelKey);
          const maybeAsync = (registered.provider as any)?.getModelMetadataAsync;

          if (!metadata && typeof maybeAsync === "function") {
               try {
                    metadata = await maybeAsync.call(registered.provider, modelKey);
               } catch (error) {
                    console.warn(`Metadata fetch failed for ${modelKey}`, error);
               }
          }

          metadataCache.set(modelKey, metadata);
          return metadata;
     };

     const index = new Map<string, any>();

     const upsertModel = async (model: Model, capability: "chat" | "embedding") => {
          if (!model?.key) {
               return;
          }

          if (!index.has(model.key)) {
               index.set(model.key, {
                    key: model.key,
                    name: model.name ?? model.key,
                    displayName: model.name ?? model.key,
                    description: undefined as string | undefined,
                    sizeLabel: undefined as string | undefined,
                    parameterLabel: undefined as string | undefined,
                    contextWindow: undefined as number | undefined,
                    supportsChat: false,
                    supportsEmbedding: false,
               });
          }

          const current = index.get(model.key);
          if (capability === "chat") {
               current.supportsChat = true;
          } else {
               current.supportsEmbedding = true;
          }

          const metadata = await fetchMetadata(model.key);
          if (metadata) {
               current.displayName = metadata.displayName ?? current.displayName;
               current.description = metadata.description ?? current.description;
               if (!current.sizeLabel && metadata.sizeGB) {
                    current.sizeLabel = formatSize(metadata.sizeGB);
               }
               if (!current.parameterLabel && metadata.parameters) {
                    current.parameterLabel = formatParameters(metadata.parameters);
               }
               current.contextWindow = metadata.contextWindow ?? current.contextWindow;
          }
     };

     const tasks: Promise<void>[] = [];

     for (const model of modelList.chat ?? []) {
          tasks.push(upsertModel(model, "chat"));
     }

     for (const model of modelList.embedding ?? []) {
          tasks.push(upsertModel(model, "embedding"));
     }

     await Promise.all(tasks);

     const payload = Array.from(index.values()).map((model) => ({
          ...model,
          sizeLabel: model.sizeLabel ?? "—",
          parameterLabel: model.parameterLabel ?? "—",
     }));

     return NextResponse.json({
          provider: {
               id: registered.id,
               name: registered.name,
               type: registered.type,
          },
          models: payload,
     });
};
