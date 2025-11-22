import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { ConfigModelProvider, Model } from "@/lib/models/types";
import { BaseModelProvider, ProviderModelMetadata } from "./BaseModelProvider";

type OpenAIConfig = {
     apiKey?: string;
     baseUrl?: string;
     temperature?: number;
     maxTokens?: number;
     apiVersion?: string;
};

type OpenAIModelListResponse = {
     data?: Array<{
          id: string;
          display_name?: string;
          context_window?: number;
          context_length?: number;
     }>;
};

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function formatModelDisplayName(modelId: string): string {
     return modelId
          .split(/[-_]/)
          .filter(Boolean)
          .map((segment) => {
               if (segment.length <= 3) {
                    return segment.toUpperCase();
               }
               return segment.charAt(0).toUpperCase() + segment.slice(1);
          })
          .join(" ");
}

async function buildOpenAIProviderMetadata(config?: OpenAIConfig): Promise<Record<string, ProviderModelMetadata>> {
     if (!config?.apiKey) {
          return {};
     }

     const baseUrl = (config.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
     const query = config.apiVersion ? `?api-version=${config.apiVersion}` : "";
     const endpoint = `${baseUrl}/models${query}`;
     const metadata: Record<string, ProviderModelMetadata> = {};

     const res = await fetch(endpoint, {
          headers: {
               Authorization: `Bearer ${config.apiKey}`,
               "Content-Type": "application/json",
          },
     });

     if (!res.ok) {
          throw new Error(`Failed to list OpenAI models: ${res.status} ${res.statusText}`);
     }

     const payload = (await res.json()) as OpenAIModelListResponse;
     for (const model of payload.data ?? []) {
          const contextWindow = model.context_window ?? model.context_length;
          metadata[model.id] = {
               key: model.id,
               displayName: model.display_name ?? formatModelDisplayName(model.id),
               contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
          };
     }

     return metadata;
}

export class OpenAIProvider extends BaseModelProvider<ChatOpenAI, OpenAIEmbeddings> {
     private metadata: Record<string, ProviderModelMetadata> = {};
     private metadataReady: Promise<void>;

     constructor(definition: ConfigModelProvider) {
          super(definition);
          this.metadataReady = this.populateMetadata();
     }

     private async populateMetadata() {
          try {
               this.metadata = await buildOpenAIProviderMetadata((this.config ?? {}) as OpenAIConfig);
          } catch (err) {
               console.error(`OpenAI metadata build failed for ${this.id}`, err);
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
