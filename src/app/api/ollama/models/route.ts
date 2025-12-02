import { NextRequest, NextResponse } from "next/server";
import { inferOllamaFamilyFromName, isRecommendedOllamaModel } from "@/lib/models/providers/OllamaProvider";
import type { OllamaTag } from "@/lib/models/ollamaClient";
import modelRegistry from "@/server/providerRegistry";

const formatSize = (bytes: number): string => {
     if (!bytes || bytes === 0) return "0 GB";
     const gb = bytes / 1024 ** 3;
     if (gb < 1) {
          const mb = bytes / 1024 ** 2;
          return mb.toFixed(0) + " MB";
     }
     return gb.toFixed(1) + " GB";
};

const formatContextWindow = (tokens: number | undefined): string | undefined => {
     if (!tokens) return undefined;
     if (tokens >= 1000000) {
          return `${(tokens / 1000000).toFixed(1)}M`;
     }
     if (tokens >= 1000) {
          return `${Math.round(tokens / 1000)}K`;
     }
     return tokens.toString();
};

// Response type from /api/show endpoint
interface OllamaShowResponse {
     modelfile?: string;
     parameters?: string;
     template?: string;
     details?: {
          parent_model?: string;
          format?: string;
          family?: string;
          families?: string[];
          parameter_size?: string;
          quantization_level?: string;
     };
     model_info?: {
          [key: string]: unknown;
          "llama.context_length"?: number;
          "general.context_length"?: number;
     };
}

// Curated list of popular Ollama models available for download
// Size is approximate download size, contextWindow is the default context length
const AVAILABLE_MODELS = [
     {
          name: "llama3.2:3b",
          size: "2.0 GB",
          contextWindow: 131072, // 128K
          description: "Meta's Llama 3.2 3B model - fast and efficient for general tasks",
          family: "Llama",
          recommended: false,
     },
     {
          name: "llama3.1:8b",
          size: "4.7 GB",
          contextWindow: 131072, // 128K
          description: "Meta's Llama 3.1 8B model - balanced performance",
          family: "Llama",
          recommended: true,
     },
     {
          name: "llama3.3:70b",
          size: "40 GB",
          contextWindow: 131072, // 128K
          description: "Meta's Llama 3.3 70B model - high performance, requires significant resources",
          family: "Llama",
          recommended: false,
     },
     {
          name: "qwen2.5:7b",
          size: "4.7 GB",
          contextWindow: 131072, // 128K
          description: "Alibaba's Qwen 2.5 7B - excellent multilingual support",
          family: "Qwen",
          recommended: false,
     },
     {
          name: "qwen2.5:14b",
          size: "9.0 GB",
          contextWindow: 32768,
          description: "Alibaba's Qwen 2.5 14B - stronger reasoning capabilities",
          family: "Qwen",
          recommended: false,
     },
     {
          name: "myaniu/qwen2.5-1m:14b",
          size: "9.0 GB",
          contextWindow: 1010000, // ~1M
          description: "Alibaba's Qwen 2.5 14B w/ large context window",
          family: "Qwen",
          recommended: false,
     },
     {
          name: "qwen2.5:32b",
          size: "19 GB",
          contextWindow: 131072, // 128K
          description: "Alibaba's Qwen 2.5 32B - advanced multilingual model",
          family: "Qwen",
          recommended: false,
     },
     {
          name: "qwen3-embedding:8b",
          size: "4.7 GB",
          contextWindow: 32768,
          description: "Alibaba's Qwen 3 Embedding 8B - optimized for text embeddings",
          family: "Qwen",
          recommended: true,
     },
     {
          name: "gemma3:27b",
          size: "16 GB",
          contextWindow: 131072, // 128K
          description: "Google's Gemma 3 27B - high-end performance",
          family: "Gemma",
          recommended: true,
     },
     {
          name: "embeddinggemma:300m",
          size: "622 MB",
          contextWindow: 8192, // 8K
          description: "Google's Embedding Gemma 300M - lightweight embedding model",
          family: "Gemma",
          recommended: false,
     },
     {
          name: "mistral:7b",
          size: "4.1 GB",
          contextWindow: 32768, // 32K
          description: "Mistral 7B - excellent for code and reasoning",
          family: "Mistral",
          recommended: true,
     },
     {
          name: "phi3:3.8b",
          size: "2.3 GB",
          contextWindow: 131072, // 128K
          description: "Microsoft's Phi-3 Mini - compact but capable",
          family: "Phi",
          recommended: false,
     },
     {
          name: "phi3:14b",
          size: "7.9 GB",
          contextWindow: 131072, // 128K
          description: "Microsoft's Phi-3 Medium - enhanced capabilities",
          family: "Phi",
          recommended: false,
     },
     {
          name: "granite3-dense:8b",
          size: "4.9 GB",
          contextWindow: 131072, // 128K
          description: "IBM's Granite 3 Dense 8B - enterprise-grade performance",
          family: "Granite",
          recommended: false,
     },
     {
          name: "granite3-moe:3b",
          size: "1.9 GB",
          contextWindow: 131072, // 128K
          description: "IBM's Granite 3 MoE 3B - mixture of experts model",
          family: "Granite",
          recommended: false,
     },
     {
          name: "r1-1776:70b",
          size: "43 GB",
          contextWindow: 131072, // 128K
          description: "Deepseek R1 1776 70B - high capacity model",
          family: "Deepseek",
          recommended: false,
     },
];

// Fetch model info to get context window size
async function fetchModelInfo(baseURL: string, modelName: string): Promise<OllamaShowResponse | null> {
     try {
          const res = await fetch(`${baseURL}/api/show`, {
               method: "POST",
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify({ model: modelName }),
          });
          if (!res.ok) return null;
          return (await res.json()) as OllamaShowResponse;
     } catch {
          return null;
     }
}

// Extract context length from model info
function getContextLength(modelInfo: OllamaShowResponse | null): number | undefined {
     if (!modelInfo?.model_info) return undefined;

     // Try common context length keys
     const info = modelInfo.model_info;
     return (
          (info["llama.context_length"] as number | undefined) ??
          (info["general.context_length"] as number | undefined) ??
          // Some models use architecture-specific keys
          (Object.entries(info).find(([key]) => key.endsWith(".context_length"))?.[1] as number | undefined)
     );
}

const EMBEDDING_HINTS = ["embedding", "embed", "vector", "text-embed"];

const includesEmbeddingHint = (value?: string) => {
     if (!value) {
          return false;
     }
     const lower = value.toLowerCase();
     return EMBEDDING_HINTS.some((hint) => lower.includes(hint));
};

type CapabilityOptions = {
     tag?: OllamaTag;
     chatConfigured?: boolean;
     embeddingConfigured?: boolean;
};

const deriveCapabilities = (modelName: string, options: CapabilityOptions) => {
     const families = new Set<string>();
     const tag = options.tag;

     if (tag?.details?.family) {
          families.add(tag.details.family.toLowerCase());
     }

     tag?.details?.families?.forEach((family) => {
          if (family) {
               families.add(family.toLowerCase());
          }
     });

     const familyIndicatesEmbedding = Array.from(families).some((family) => includesEmbeddingHint(family));
     const nameIndicatesEmbedding = includesEmbeddingHint(modelName);
     const isEmbeddingSpecialized = familyIndicatesEmbedding || nameIndicatesEmbedding;

     const supportsEmbedding = Boolean(options.embeddingConfigured) || isEmbeddingSpecialized;
     const supportsChat = Boolean(options.chatConfigured) || !isEmbeddingSpecialized;

     return { supportsChat, supportsEmbedding };
};

export async function GET(req: NextRequest) {
     const { searchParams } = new URL(req.url);
     const baseURL = searchParams.get("baseURL")?.trim() || "http://127.0.0.1:11434";
     const providerId = searchParams.get("providerId")?.trim();

     try {
          // Fetch installed models
          const res = await fetch(`${baseURL}/api/tags`, {
               headers: {
                    "Content-Type": "application/json",
               },
          });

          const installedModels = new Map<string, OllamaTag>();

          if (res.ok) {
               const data = (await res.json()) as { models?: OllamaTag[] };
               if (Array.isArray(data.models)) {
                    data.models.forEach((model) => {
                         if (typeof model?.name === "string" && model.name.trim().length > 0) {
                              installedModels.set(model.name, model);
                         }
                    });
               }
          }

          // Fetch model info for all installed models in parallel to get context window
          const modelInfoMap = new Map<string, OllamaShowResponse | null>();
          const installedModelNames = Array.from(installedModels.keys());

          const modelInfoPromises = installedModelNames.map(async (name) => {
               const info = await fetchModelInfo(baseURL, name);
               return { name, info };
          });

          const modelInfoResults = await Promise.all(modelInfoPromises);
          modelInfoResults.forEach(({ name, info }) => {
               modelInfoMap.set(name, info);
          });

          // Get provider info if providerId is provided
          let currentChatModels = new Set<string>();
          let currentEmbeddingModels = new Set<string>();

          if (providerId) {
               const provider = modelRegistry.getProviderById(providerId);
               if (provider) {
                    currentChatModels = new Set(provider.chatModels?.map((m) => m.key) || []);
                    currentEmbeddingModels = new Set(provider.embeddingModels?.map((m) => m.key) || []);
               }
          }

          const curatedNameSet = new Set(AVAILABLE_MODELS.map((model) => model.name));

          // Combine available models with installation status
          const allModels = AVAILABLE_MODELS.map((model) => {
               const tag = installedModels.get(model.name);
               const modelInfo = modelInfoMap.get(model.name);
               const { supportsChat, supportsEmbedding } = deriveCapabilities(model.name, {
                    tag,
                    chatConfigured: currentChatModels.has(model.name),
                    embeddingConfigured: currentEmbeddingModels.has(model.name),
               });

               // Use actual size from Ollama if installed, otherwise use curated size
               const actualSize = tag?.size ? formatSize(tag.size) : model.size;

               // Use actual context length from model info if available, otherwise use curated value
               const actualContextLength = getContextLength(modelInfo ?? null) ?? model.contextWindow;

               return {
                    name: model.name,
                    size: actualSize,
                    contextWindow: formatContextWindow(actualContextLength),
                    description: model.description,
                    installed: Boolean(tag),
                    recommended: isRecommendedOllamaModel(model.name) || model.recommended,
                    family: model.family || inferOllamaFamilyFromName(model.name),
                    supportsChat,
                    supportsEmbedding,
                    isChatModel: currentChatModels.has(model.name),
                    isEmbeddingModel: currentEmbeddingModels.has(model.name),
               };
          });

          // Add installed models that aren't in AVAILABLE_MODELS
          installedModels.forEach((modelData, modelName) => {
               if (curatedNameSet.has(modelName)) {
                    return;
               }

               const modelInfo = modelInfoMap.get(modelName) ?? null;
               const { supportsChat, supportsEmbedding } = deriveCapabilities(modelName, {
                    tag: modelData,
                    chatConfigured: currentChatModels.has(modelName),
                    embeddingConfigured: currentEmbeddingModels.has(modelName),
               });

               const contextLength = getContextLength(modelInfo);

               allModels.push({
                    name: modelName,
                    size: formatSize(modelData.size || 0),
                    contextWindow: formatContextWindow(contextLength),
                    description: `Local model - ${modelName}`,
                    installed: true,
                    recommended: false,
                    family: inferOllamaFamilyFromName(modelName),
                    supportsChat,
                    supportsEmbedding,
                    isChatModel: currentChatModels.has(modelName),
                    isEmbeddingModel: currentEmbeddingModels.has(modelName),
               });
          });

          // Sort: recommended first, then by name
          allModels.sort((a, b) => {
               if (a.recommended !== b.recommended) {
                    return a.recommended ? -1 : 1;
               }
               return a.name.localeCompare(b.name);
          });

          return NextResponse.json({ models: allModels });
     } catch (error) {
          console.error("Error fetching Ollama models:", error);
          return NextResponse.json(
               { error: error instanceof Error ? error.message : "Failed to fetch models" },
               { status: 500 }
          );
     }
}
