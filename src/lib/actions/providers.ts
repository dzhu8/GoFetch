"use server";

import ModelRegistry from "@/server/providerRegistry";
import { ConfigModelProvider } from "@/lib/models/types";
import type { Model } from "@/lib/models/types";
import type { ProviderModelMetadata } from "@/lib/models/providers/BaseModelProvider";
import crypto from "crypto";

// ── GET /api/providers ──────────────────────────────────────────────

export async function getProviders() {
     try {
          const providers = await ModelRegistry.getActiveProviders();

          return { providers };
     } catch (err) {
          console.error("Error fetching providers:", err);
          return { error: "An error has occurred while fetching providers." };
     }
}

// ── POST /api/providers ─────────────────────────────────────────────

export async function addProvider(data: {
     name: string;
     type: string;
     chatModels?: Model[];
     embeddingModels?: Model[];
     ocrModels?: Model[];
     config?: Record<string, unknown>;
}) {
     try {
          if (!data.name || !data.type) {
               return { error: "Provider name and type are required." };
          }

          // Generate a unique ID for the new provider
          const id = `${data.type.toLowerCase()}-${Date.now()}`;

          // Generate a hash for the provider configuration
          const hash = crypto
               .createHash("sha256")
               .update(JSON.stringify({ id, name: data.name, type: data.type, config: data.config || {} }))
               .digest("hex")
               .substring(0, 16);

          const newProvider: ConfigModelProvider = {
               id,
               name: data.name,
               type: data.type.toLowerCase(),
               chatModels: data.chatModels || [],
               embeddingModels: data.embeddingModels || [],
               ocrModels: data.ocrModels || [],
               config: data.config || {},
               hash,
          };

          const addedProvider = ModelRegistry.addProvider(newProvider);

          return {
               message: "Provider added successfully.",
               provider: addedProvider,
          };
     } catch (err) {
          console.error("Error adding provider:", err);

          if (err instanceof Error && err.message.includes("already exists")) {
               return { error: err.message };
          }

          return { error: "An error has occurred while adding the provider." };
     }
}

// ── PATCH /api/providers/[id] ───────────────────────────────────────

export async function updateProvider(
     id: string,
     data: {
          chatModels?: Model[];
          embeddingModels?: Model[];
          ocrModels?: Model[];
          config?: Record<string, unknown>;
     }
) {
     try {
          if (!id) {
               return { error: "Provider ID is required." };
          }

          // Check if provider exists
          const provider = ModelRegistry.getProviderById(id);
          if (!provider) {
               return { error: "Provider not found." };
          }

          // Update the provider with new data
          const updatedProvider = {
               ...provider,
               chatModels: data.chatModels !== undefined ? data.chatModels : provider.chatModels,
               embeddingModels: data.embeddingModels !== undefined ? data.embeddingModels : provider.embeddingModels,
               ocrModels: data.ocrModels !== undefined ? data.ocrModels : provider.ocrModels,
               config: data.config !== undefined ? data.config : provider.config,
          };

          // Regenerate hash
          updatedProvider.hash = crypto
               .createHash("sha256")
               .update(
                    JSON.stringify({
                         id: updatedProvider.id,
                         name: updatedProvider.name,
                         type: updatedProvider.type,
                         config: updatedProvider.config,
                    })
               )
               .digest("hex")
               .substring(0, 16);

          const result = ModelRegistry.updateProvider(updatedProvider);

          return {
               message: "Provider updated successfully.",
               provider: result,
          };
     } catch (err) {
          console.error("Error updating provider:", err);
          return { error: "An error has occurred while updating the provider." };
     }
}

// ── DELETE /api/providers/[id] ──────────────────────────────────────

export async function deleteProvider(id: string) {
     try {
          if (!id) {
               return { error: "Provider ID is required." };
          }

          // Check if provider exists
          const provider = ModelRegistry.getProviderById(id);
          if (!provider) {
               return { error: "Provider not found." };
          }

          ModelRegistry.removeProvider(id);

          return {
               message: "Provider deleted successfully.",
          };
     } catch (err) {
          console.error("Error deleting provider:", err);
          return { error: "An error has occurred while deleting the provider." };
     }
}

// ── GET /api/providers/[id]/models ──────────────────────────────────

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

const formatContextWindow = (tokens?: number): string | undefined => {
     if (typeof tokens !== "number" || Number.isNaN(tokens) || tokens <= 0) return undefined;
     if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
     if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
     return tokens.toString();
};

export async function getProviderModels(id: string) {
     if (!id) {
          return { error: "Provider id is required" };
     }

     const registered = ModelRegistry.getProviderById(id);

     if (!registered) {
          return { error: "Provider not found" };
     }

     let modelList;

     try {
          modelList = await registered.provider.getModelList();
     } catch (error) {
          console.error(`[providers/${id}/models] Failed to load model list`, error);
          modelList = {
               chat: registered.chatModels ?? [],
               embedding: registered.embeddingModels ?? [],
               ocr: registered.ocrModels ?? [],
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

     const upsertModel = async (model: Model, capability: "chat" | "embedding" | "ocr") => {
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
                    inputPricePerMToken: undefined as number | undefined,
                    outputPricePerMToken: undefined as number | undefined,
                    supportsChat: false,
                    supportsEmbedding: false,
                    supportsOCR: false,
               });
          }

          const current = index.get(model.key);
          if (capability === "chat") {
               current.supportsChat = true;
          } else if (capability === "embedding") {
               current.supportsEmbedding = true;
          } else if (capability === "ocr") {
               current.supportsOCR = true;
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
               if (typeof metadata.inputPricePerMToken === "number") {
                    current.inputPricePerMToken = metadata.inputPricePerMToken;
               }
               if (typeof metadata.outputPricePerMToken === "number") {
                    current.outputPricePerMToken = metadata.outputPricePerMToken;
               }
          }
     };

     const tasks: Promise<void>[] = [];

     for (const model of modelList.chat ?? []) {
          tasks.push(upsertModel(model, "chat"));
     }

     for (const model of modelList.ocr ?? []) {
          tasks.push(upsertModel(model, "ocr"));
     }
     for (const model of modelList.embedding ?? []) {
          tasks.push(upsertModel(model, "embedding"));
     }

     await Promise.all(tasks);

     const payload = Array.from(index.values()).map((model) => ({
          ...model,
          sizeLabel: model.sizeLabel ?? "\u2014",
          parameterLabel: model.parameterLabel ?? "\u2014",
          contextWindow: formatContextWindow(model.contextWindow) ?? model.contextWindow,
     }));

     return {
          provider: {
               id: registered.id,
               name: registered.name,
               type: registered.type,
          },
          models: payload,
     };
}
