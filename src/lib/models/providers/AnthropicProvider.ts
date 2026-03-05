import { ChatAnthropic } from "@langchain/anthropic";
import { ConfigModelProvider, Model, ModelList } from "@/lib/models/types";
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

const DEFAULT_CHAT_MODELS: Model[] = [
     { key: "claude-opus-4-6",              name: "Claude Opus 4.6" },
     { key: "claude-sonnet-4-6",            name: "Claude Sonnet 4.6" },
     { key: "claude-opus-4-5",              name: "Claude Opus 4.5" },
     { key: "claude-sonnet-4-5",            name: "Claude Sonnet 4.5" },
     { key: "claude-haiku-4-5",             name: "Claude Haiku 4.5" },
     { key: "claude-opus-4-1",              name: "Claude Opus 4.1" },
     { key: "claude-opus-4",                name: "Claude Opus 4" },
     { key: "claude-sonnet-4",              name: "Claude Sonnet 4" },
     { key: "claude-haiku-4",               name: "Claude Haiku 4" },
];

/** Static metadata for well-known Anthropic models (pricing per 1M tokens). */
const ANTHROPIC_MODEL_METADATA: Record<string, ProviderModelMetadata> = {
     "claude-opus-4-6":              { key: "claude-opus-4-6",              displayName: "Claude Opus 4.6",    contextWindow: 200_000, inputPricePerMToken: 15.00, outputPricePerMToken: 75.00 },
     "claude-sonnet-4-6":            { key: "claude-sonnet-4-6",            displayName: "Claude Sonnet 4.6",  contextWindow: 200_000, inputPricePerMToken: 3.00,  outputPricePerMToken: 15.00 },
     "claude-opus-4-5":              { key: "claude-opus-4-5",              displayName: "Claude Opus 4.5",    contextWindow: 200_000, inputPricePerMToken: 15.00, outputPricePerMToken: 75.00 },
     "claude-sonnet-4-5":            { key: "claude-sonnet-4-5",            displayName: "Claude Sonnet 4.5",  contextWindow: 200_000, inputPricePerMToken: 3.00,  outputPricePerMToken: 15.00 },
     "claude-haiku-4-5":             { key: "claude-haiku-4-5",             displayName: "Claude Haiku 4.5",   contextWindow: 200_000, inputPricePerMToken: 0.80,  outputPricePerMToken: 4.00  },
     "claude-opus-4-1":              { key: "claude-opus-4-1",              displayName: "Claude Opus 4.1",    contextWindow: 200_000, inputPricePerMToken: 15.00, outputPricePerMToken: 75.00 },
     "claude-opus-4":                { key: "claude-opus-4",                displayName: "Claude Opus 4",      contextWindow: 200_000, inputPricePerMToken: 15.00, outputPricePerMToken: 75.00 },
     "claude-sonnet-4":              { key: "claude-sonnet-4",              displayName: "Claude Sonnet 4",    contextWindow: 200_000, inputPricePerMToken: 3.00,  outputPricePerMToken: 15.00 },
     "claude-haiku-4":               { key: "claude-haiku-4",               displayName: "Claude Haiku 4",     contextWindow: 200_000, inputPricePerMToken: 0.80,  outputPricePerMToken: 4.00  },
};

function formatAnthropicModelName(modelId: string): string {
     return modelId
          .split(/[-_]/)
          .filter(Boolean)
          .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
          .join(" ");
}

/** Look up static metadata, accounting for date-suffixed API model IDs (e.g. claude-sonnet-4-6-20260101). */
function resolveStaticMetadata(modelKey: string): ProviderModelMetadata | undefined {
     if (ANTHROPIC_MODEL_METADATA[modelKey]) return ANTHROPIC_MODEL_METADATA[modelKey];
     const normalized = modelKey.replace(/-\d{8}$/, "");
     return ANTHROPIC_MODEL_METADATA[normalized];
}

/** Merge static + API metadata, ignoring undefined API values so they don't overwrite static ones. */
function mergeMetadata(
     staticMeta: ProviderModelMetadata | undefined,
     apiMeta: ProviderModelMetadata | undefined,
): ProviderModelMetadata | undefined {
     if (!staticMeta && !apiMeta) return undefined;
     if (!staticMeta) return apiMeta;
     if (!apiMeta) return staticMeta;
     const merged: Record<string, unknown> = { ...staticMeta };
     for (const [k, v] of Object.entries(apiMeta)) {
          if (v !== undefined) merged[k] = v;
     }
     return merged as ProviderModelMetadata;
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
          return mergeMetadata(resolveStaticMetadata(modelKey), this.metadata[modelKey]);
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
          return mergeMetadata(resolveStaticMetadata(modelKey), this.metadata[modelKey]);
     }

     async getModelList(): Promise<ModelList> {
          await this.ensureMetadata();

          const registeredChat = this.definition.chatModels ?? [];

          // Merge API-discovered models over the default list, then append any
          // user-registered models not already present.
          const apiModels: Model[] = Object.entries(this.metadata).map(([key, meta]) => ({
               key,
               name: meta.displayName ?? key,
          }));

          const base = apiModels.length > 0 ? apiModels : DEFAULT_CHAT_MODELS;
          const seen = new Set(base.map((m) => m.key));
          const chat = [...base, ...registeredChat.filter((m) => !seen.has(m.key))];

          return { chat, embedding: this.definition.embeddingModels ?? [], ocr: [] };
     }
}
