import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { Model } from "@/lib/models/types";
import { BaseModelProvider, ProviderModelMetadata } from "./BaseModelProvider";

type OpenAIConfig = {
     apiKey?: string;
     baseUrl?: string;
     temperature?: number;
     maxTokens?: number;
};

export class OpenAIProvider extends BaseModelProvider<ChatOpenAI, OpenAIEmbeddings> {
     private readonly metadata: Record<string, ProviderModelMetadata> = {
          "gpt-4o-mini": {
               key: "gpt-4o-mini",
               displayName: "GPT-4o Mini",
               contextWindow: 128000,
               description: "Cost-effective GPT-4o variant for fast general chat.",
          },
          "gpt-4.1": {
               key: "gpt-4.1",
               displayName: "GPT-4.1",
               contextWindow: 200000,
               description: "Latest flagship OpenAI reasoning model.",
          },
          "text-embedding-3-small": {
               key: "text-embedding-3-small",
               displayName: "Text Embedding 3 Small",
               sizeGB: 1.5,
               description: "Lightweight embedding model optimised for search.",
          },
          "text-embedding-3-large": {
               key: "text-embedding-3-large",
               displayName: "Text Embedding 3 Large",
               sizeGB: 3.8,
               description: "Highest quality OpenAI embedding model.",
          },
     };

     getAvailableChatModels(): Model[] {
          return this.definition.chatModels ?? [];
     }

     getAvailableEmbeddingModels(): Model[] {
          return this.definition.embeddingModels ?? [];
     }

     async loadChatModel(modelKey: string): Promise<ChatOpenAI> {
          this.assertModelConfigured(modelKey, this.getAvailableChatModels());

          const { apiKey, baseUrl, temperature, maxTokens } = (this.config ?? {}) as OpenAIConfig;

          if (!apiKey) {
               throw new Error("Missing OpenAI API key in provider configuration.");
          }

          const options: Record<string, any> = {
               model: modelKey,
               apiKey,
          };

          if (typeof temperature === "number") {
               options.temperature = temperature;
          }

          if (typeof maxTokens === "number") {
               options.maxTokens = maxTokens;
          }

          if (baseUrl) {
               options.configuration = { baseURL: baseUrl };
          }

          return new ChatOpenAI(options);
     }

     async loadEmbeddingModel(modelKey: string): Promise<OpenAIEmbeddings> {
          this.assertModelConfigured(modelKey, this.getAvailableEmbeddingModels());

          const { apiKey, baseUrl } = (this.config ?? {}) as OpenAIConfig;

          if (!apiKey) {
               throw new Error("Missing OpenAI API key in provider configuration.");
          }

          const options: Record<string, any> = {
               model: modelKey,
               apiKey,
          };

          if (baseUrl) {
               options.configuration = { baseURL: baseUrl };
          }

          return new OpenAIEmbeddings(options);
     }

     getModelMetadata(modelKey: string): ProviderModelMetadata | undefined {
          return this.metadata[modelKey];
     }
}
