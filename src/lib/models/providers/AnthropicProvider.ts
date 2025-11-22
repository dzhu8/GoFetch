import { ChatAnthropic } from "@langchain/anthropic";
import { Model } from "@/lib/models/types";
import { BaseModelProvider, ProviderModelMetadata } from "./BaseModelProvider";

type AnthropicConfig = {
     apiKey?: string;
     baseUrl?: string;
     temperature?: number;
     maxTokens?: number;
};

export class AnthropicProvider extends BaseModelProvider<ChatAnthropic, never> {
     private readonly metadata: Record<string, ProviderModelMetadata> = {
          "claude-3-5-sonnet-20241022": {
               key: "claude-3-5-sonnet-20241022",
               displayName: "Claude 3.5 Sonnet",
               parameters: 220000000000,
               contextWindow: 200000,
               description: "Balanced flagship Claude model for high quality reasoning.",
          },
          "claude-3-opus-20240229": {
               key: "claude-3-opus-20240229",
               displayName: "Claude 3 Opus",
               parameters: 300000000000,
               contextWindow: 200000,
               description: "Anthropic's most capable general intelligence model.",
          },
     };

     getAvailableChatModels(): Model[] {
          return this.definition.chatModels ?? [];
     }

     getAvailableEmbeddingModels(): Model[] {
          return this.definition.embeddingModels ?? [];
     }

     async loadChatModel(modelKey: string): Promise<ChatAnthropic> {
          this.assertModelConfigured(modelKey, this.getAvailableChatModels());

          const { apiKey, baseUrl, temperature, maxTokens } = (this.config ?? {}) as AnthropicConfig;

          if (!apiKey) {
               throw new Error("Missing Anthropic API key in provider configuration.");
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

          return new ChatAnthropic(options);
     }

     async loadEmbeddingModel(): Promise<never> {
          throw new Error("Anthropic does not currently expose embeddings through LangChain.");
     }

     getModelMetadata(modelKey: string): ProviderModelMetadata | undefined {
          return this.metadata[modelKey];
     }
}
