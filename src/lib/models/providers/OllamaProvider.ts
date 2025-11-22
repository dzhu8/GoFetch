import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { Model } from "@/lib/models/types";
import { BaseModelProvider, ProviderModelMetadata } from "./BaseModelProvider";

type OllamaConfig = {
     baseUrl?: string;
     temperature?: number;
};

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export class OllamaProvider extends BaseModelProvider<ChatOllama, OllamaEmbeddings> {
     private readonly metadata: Record<string, ProviderModelMetadata> = {
          "llama3.2": {
               key: "llama3.2",
               displayName: "Llama 3.2 3B",
               parameters: 3000000000,
               sizeGB: 2.1,
               description: "Fast local chat model shipping with Ollama.",
          },
          "llama3.1": {
               key: "llama3.1",
               displayName: "Llama 3.1 8B",
               parameters: 8000000000,
               sizeGB: 4.8,
               description: "Balanced Meta model optimised for on-device inference.",
          },
          mistral: {
               key: "mistral",
               displayName: "Mistral 7B",
               parameters: 7000000000,
               sizeGB: 4.1,
               description: "General-purpose local model from Mistral AI.",
          },
          "nomic-embed-text": {
               key: "nomic-embed-text",
               displayName: "Nomic Embed Text",
               sizeGB: 1.8,
               description: "High-quality general text embedding model.",
          },
     };

     getAvailableChatModels(): Model[] {
          return this.definition.chatModels ?? [];
     }

     getAvailableEmbeddingModels(): Model[] {
          return this.definition.embeddingModels ?? [];
     }

     async loadChatModel(modelKey: string): Promise<ChatOllama> {
          this.assertModelConfigured(modelKey, this.getAvailableChatModels());

          const { baseUrl, temperature } = (this.config ?? {}) as OllamaConfig;

          return new ChatOllama({
               model: modelKey,
               baseUrl: baseUrl ?? DEFAULT_OLLAMA_URL,
               temperature: typeof temperature === "number" ? temperature : undefined,
          });
     }

     async loadEmbeddingModel(modelKey: string): Promise<OllamaEmbeddings> {
          this.assertModelConfigured(modelKey, this.getAvailableEmbeddingModels());

          const { baseUrl } = (this.config ?? {}) as OllamaConfig;

          return new OllamaEmbeddings({
               model: modelKey,
               baseUrl: baseUrl ?? DEFAULT_OLLAMA_URL,
          });
     }

     getModelMetadata(modelKey: string): ProviderModelMetadata | undefined {
          return this.metadata[modelKey];
     }
}
