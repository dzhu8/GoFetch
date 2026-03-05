import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import { ConfigModelProvider, Model, ModelList } from "@/lib/models/types";
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

const DEFAULT_CHAT_MODELS: Model[] = [
     { key: "gpt-5.2", name: "GPT-5.2" },
     { key: "gpt-5", name: "GPT-5" },
     { key: "gpt-5-mini", name: "GPT-5 mini" },
     { key: "gpt-5-nano", name: "GPT-5 nano" },
     { key: "gpt-4.1", name: "GPT-4.1" },
     { key: "gpt-4o", name: "GPT-4o" },
     { key: "gpt-4o-mini", name: "GPT-4o mini" }
];

const DEFAULT_EMBEDDING_MODELS: Model[] = [
     { key: "text-embedding-3-small", name: "Text Embedding 3 Small" },
     { key: "text-embedding-3-large", name: "Text Embedding 3 Large" },
];

/** Static metadata for well-known OpenAI models (pricing per 1M tokens). */
const OPENAI_MODEL_METADATA: Record<string, ProviderModelMetadata> = {
     "gpt-5.2":              { key: "gpt-5.2",              displayName: "GPT-5.2",              contextWindow: 400_000,   inputPricePerMToken: 1.75,  outputPricePerMToken: 14.00  },
     "gpt-5":                { key: "gpt-5",                displayName: "GPT-5",                contextWindow: 400_000,   inputPricePerMToken: 1.25,  outputPricePerMToken: 10.00  },
     "gpt-5-mini":           { key: "gpt-5-mini",           displayName: "GPT-5 mini",           contextWindow: 400_000,   inputPricePerMToken: 0.25,  outputPricePerMToken: 2.00   },
     "gpt-5-nano":           { key: "gpt-5-nano",           displayName: "GPT-5 nano",           contextWindow: 400_000,   inputPricePerMToken: 0.05,  outputPricePerMToken: 0.40   },
     "gpt-4.1":              { key: "gpt-4.1",              displayName: "GPT-4.1",              contextWindow: 1_047_576, inputPricePerMToken: 2.00,  outputPricePerMToken: 8.00   },
     "gpt-4o":               { key: "gpt-4o",               displayName: "GPT-4o",               contextWindow: 128_000,   inputPricePerMToken: 2.50,  outputPricePerMToken: 10.00  },
     "gpt-4o-mini":          { key: "gpt-4o-mini",          displayName: "GPT-4o mini",          contextWindow: 128_000,   inputPricePerMToken: 0.15,  outputPricePerMToken: 0.60   },
     "text-embedding-3-small": { key: "text-embedding-3-small", displayName: "Text Embedding 3 Small", contextWindow: 8_191, inputPricePerMToken: 0.02 },
     "text-embedding-3-large": { key: "text-embedding-3-large", displayName: "Text Embedding 3 Large", contextWindow: 8_191, inputPricePerMToken: 0.13 },
};

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
          const entry: ProviderModelMetadata = {
               key: model.id,
               displayName: model.display_name ?? formatModelDisplayName(model.id),
          };
          if (typeof contextWindow === "number") {
               entry.contextWindow = contextWindow;
          }
          metadata[model.id] = entry;
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
          const apiMeta = this.metadata[modelKey];
          const staticMeta = OPENAI_MODEL_METADATA[modelKey];
          if (!apiMeta && !staticMeta) return undefined;
          return { ...staticMeta, ...apiMeta };
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

     async loadOCRModel(_modelKey: string): Promise<any> {
          throw new Error("OpenAI provider does not currently support local OCR models.");
     }

     getModelMetadata(modelKey: string): ProviderModelMetadata | undefined {
          const apiMeta = this.metadata[modelKey];
          const staticMeta = OPENAI_MODEL_METADATA[modelKey];
          if (!apiMeta && !staticMeta) return undefined;
          return { ...staticMeta, ...apiMeta };
     }

     async getModelList(): Promise<ModelList> {
          const { baseUrl } = (this.config ?? {}) as OpenAIConfig;
          const isStandardOpenAI =
               !baseUrl || baseUrl.replace(/\/+$/, "") === DEFAULT_OPENAI_BASE_URL;

          // For the default OpenAI endpoint, start with well-known models.
          // For custom base URLs (Groq, Together, etc.), only show user-registered models.
          const defaultChat = isStandardOpenAI ? DEFAULT_CHAT_MODELS : [];
          const defaultEmbedding = isStandardOpenAI ? DEFAULT_EMBEDDING_MODELS : [];

          const registeredChat = this.definition.chatModels ?? [];
          const registeredEmbedding = this.definition.embeddingModels ?? [];

          // Merge: defaults first, then any user-added models not already in the list
          const seenChat = new Set(defaultChat.map((m) => m.key));
          const chat = [...defaultChat, ...registeredChat.filter((m) => !seenChat.has(m.key))];

          const seenEmbed = new Set(defaultEmbedding.map((m) => m.key));
          const embedding = [...defaultEmbedding, ...registeredEmbedding.filter((m) => !seenEmbed.has(m.key))];

          return { chat, embedding, ocr: [] };
     }
}
