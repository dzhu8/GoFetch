import { ChatAnthropic } from "@langchain/anthropic";
import { ConfigModelProvider, Model } from "@/lib/models/types";
import { BaseModelProvider, ProviderModelMetadata } from "./BaseModelProvider";

type AnthropicConfig = {
     apiKey?: string;
     baseUrl?: string;
     temperature?: number;
     maxTokens?: number;
     version?: string;
};

type AnthropicModelListResponse = {
     data?: Array<{
          id: string;
          display_name?: string;
          description?: string;
          context_window?: number;
          context_length?: number;
     }>;
};

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

function formatAnthropicModelName(modelId: string): string {
     return modelId
          .split(/[-_]/)
          .filter(Boolean)
          .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
          .join(" ");
}

async function buildAnthropicProviderMetadata(
     config?: AnthropicConfig
): Promise<Record<string, ProviderModelMetadata>> {
     if (!config?.apiKey) {
          return {};
     }

     const baseUrl = (config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
     const version = config.version ?? DEFAULT_ANTHROPIC_VERSION;
     const endpoint = `${baseUrl}/v1/models`;
     const metadata: Record<string, ProviderModelMetadata> = {};

     const res = await fetch(endpoint, {
          headers: {
               "x-api-key": config.apiKey,
               "anthropic-version": version,
               Accept: "application/json",
          },
     });

     if (!res.ok) {
          throw new Error(`Failed to list Anthropic models: ${res.status} ${res.statusText}`);
     }

     const payload = (await res.json()) as AnthropicModelListResponse;
     for (const model of payload.data ?? []) {
          const contextWindow = model.context_window ?? model.context_length;
          metadata[model.id] = {
               key: model.id,
               displayName: model.display_name ?? formatAnthropicModelName(model.id),
               description: model.description,
               contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
          };
     }

     return metadata;
}

export class AnthropicProvider extends BaseModelProvider<ChatAnthropic, never> {
     private metadata: Record<string, ProviderModelMetadata> = {};
     private metadataReady: Promise<void>;

     constructor(definition: ConfigModelProvider) {
          super(definition);
          this.metadataReady = this.populateMetadata();
     }

     private async populateMetadata() {
          try {
               this.metadata = await buildAnthropicProviderMetadata((this.config ?? {}) as AnthropicConfig);
          } catch (err) {
               console.error(`Anthropic metadata build failed for ${this.id}`, err);
               this.metadata = {};
          }
     }

     private async ensureMetadata() {
          await this.metadataReady;
     }

     async getModelMetadataAsync(modelKey: string) {
          await this.ensureMetadata();
          return this.metadata[modelKey];
     }

     getAvailableChatModels(): Model[] {
          return this.definition.chatModels ?? [];
     }

     getAvailableEmbeddingModels(): Model[] {
          return this.definition.embeddingModels ?? [];
     }

     getAvailableOCRModels(): Model[] {
          return this.definition.ocrModels ?? [];
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

     async loadOCRModel(_modelKey: string): Promise<any> {
          throw new Error("Anthropic provider does not currently support local OCR models.");
     }

     getModelMetadata(modelKey: string): ProviderModelMetadata | undefined {
          return this.metadata[modelKey];
     }
}
