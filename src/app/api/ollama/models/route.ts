import { NextRequest, NextResponse } from "next/server";
import { inferOllamaFamilyFromName, isRecommendedOllamaModel } from "@/lib/models/providers/OllamaProvider";
import modelRegistry from "@/server/providerRegistry";

const formatSize = (bytes: number): string => {
     if (!bytes || bytes === 0) return "0 GB";
     const gb = bytes / 1024 ** 3;
     return gb.toFixed(1) + " GB";
};

// Curated list of popular Ollama models available for download
const AVAILABLE_MODELS = [
     {
          name: "llama3.2:3b",
          size: "2.0 GB",
          description: "Meta's Llama 3.2 3B model - fast and efficient for general tasks",
          family: "Llama",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "llama3.2:1b",
          size: "1.3 GB",
          description: "Meta's Llama 3.2 1B model - ultra lightweight",
          family: "Llama",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "llama3.1:8b",
          size: "4.7 GB",
          description: "Meta's Llama 3.1 8B model - balanced performance",
          family: "Llama",
          recommended: true,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "llama3.3:70b",
          size: "40 GB",
          description: "Meta's Llama 3.3 70B model - high performance, requires significant resources",
          family: "Llama",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "qwen2.5:7b",
          size: "4.7 GB",
          description: "Alibaba's Qwen 2.5 7B - excellent multilingual support",
          family: "Qwen",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "qwen2.5:14b",
          size: "9.0 GB",
          description: "Alibaba's Qwen 2.5 14B - stronger reasoning capabilities",
          family: "Qwen",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "qwen2.5:32b",
          size: "19 GB",
          description: "Alibaba's Qwen 2.5 32B - advanced multilingual model",
          family: "Qwen",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "qwen3-embedding:8b",
          size: "4.7 GB",
          description: "Alibaba's Qwen 3 Embedding 8B - optimized for text embeddings",
          family: "Qwen",
          recommended: true,
          supportsChat: false,
          supportsEmbedding: true,
     },
     {
          name: "gemma2:9b",
          size: "5.5 GB",
          description: "Google's Gemma 2 9B - strong performance on reasoning tasks",
          family: "Gemma",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "gemma3:27b",
          size: "16 GB",
          description: "Google's Gemma 3 27B - high-end performance",
          family: "Gemma",
          recommended: true,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "mistral:7b",
          size: "4.1 GB",
          description: "Mistral 7B - excellent for code and reasoning",
          family: "Mistral",
          recommended: true,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "phi3:3.8b",
          size: "2.3 GB",
          description: "Microsoft's Phi-3 Mini - compact but capable",
          family: "Phi",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "phi3:14b",
          size: "7.9 GB",
          description: "Microsoft's Phi-3 Medium - enhanced capabilities",
          family: "Phi",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "granite3-dense:8b",
          size: "4.9 GB",
          description: "IBM's Granite 3 Dense 8B - enterprise-grade performance",
          family: "Granite",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "granite3-moe:3b",
          size: "1.9 GB",
          description: "IBM's Granite 3 MoE 3B - mixture of experts model",
          family: "Granite",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
     {
          name: "r1-1776:70b",
          size: "43 GB",
          description: "Deepseek R1 1776 70B - high capacity model",
          family: "Deepseek",
          recommended: false,
          supportsChat: true,
          supportsEmbedding: true,
     },
];

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

          const installedModels = new Map<string, any>();

          if (res.ok) {
               const data = await res.json();
               if (data.models && Array.isArray(data.models)) {
                    data.models.forEach((model: any) => {
                         installedModels.set(model.name || "", model);
                    });
               }
          }

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

          // Combine available models with installation status
          const allModels = AVAILABLE_MODELS.map((model) => ({
               name: model.name,
               size: model.size,
               description: model.description,
               installed: installedModels.has(model.name),
               recommended: isRecommendedOllamaModel(model.name) || model.recommended,
               family: model.family || inferOllamaFamilyFromName(model.name),
               supportsChat: model.supportsChat,
               supportsEmbedding: model.supportsEmbedding,
               isChatModel: currentChatModels.has(model.name),
               isEmbeddingModel: currentEmbeddingModels.has(model.name),
          }));

          // Add installed models that aren't in AVAILABLE_MODELS
          installedModels.forEach((modelData, modelName) => {
               if (!AVAILABLE_MODELS.some((m) => m.name === modelName)) {
                    allModels.push({
                         name: modelName,
                         size: formatSize(modelData.size || 0),
                         description: `Local model - ${modelName}`,
                         installed: true,
                         recommended: false,
                         family: inferOllamaFamilyFromName(modelName),
                         supportsChat: true,
                         supportsEmbedding: true,
                         isChatModel: currentChatModels.has(modelName),
                         isEmbeddingModel: currentEmbeddingModels.has(modelName),
                    });
               }
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
