import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { ConfigModelProvider, Model } from "@/lib/models/types";
import { BaseModelProvider, ProviderModelMetadata } from "./BaseModelProvider";
import { listOllamaModels, OllamaTag } from "../ollamaClient";

//#region Get all Ollama Models
export type ModelFamily = "Llama" | "Qwen" | "Gemma" | "Mistral" | "Phi" | "Granite" | "Other";

interface OllamaProviderMetadata extends ProviderModelMetadata {
     family: ModelFamily;
     recommended?: boolean;
}

function bytesToGB(bytes: number | undefined): number | undefined {
     if (bytes == null) return undefined;
     return bytes / 1024 ** 3; // GiB
}

export function inferOllamaFamilyFromName(name: string): ModelFamily {
     const lower = name.toLowerCase();
     if (lower.includes("llama")) return "Llama";
     if (lower.includes("qwen")) return "Qwen";
     if (lower.includes("gemma")) return "Gemma";
     if (lower.includes("mistral")) return "Mistral";
     if (lower.includes("phi")) return "Phi";
     if (lower.includes("granite")) return "Granite";
     return "Other";
}

function inferFamily(tag: OllamaTag): ModelFamily {
     const d = tag.details;
     // if Ollama already tells us the family, use it
     if (d?.family) {
          return inferOllamaFamilyFromName(d.family);
     }
     if (d?.families && d.families.length > 0) {
          return inferOllamaFamilyFromName(d.families[0]);
     }
     // fallback to model name
     return inferOllamaFamilyFromName(tag.name);
}

const RECOMMENDED_KEYWORDS = ["qwen3-embedding:8b", "gpt-oss:20b", "gemma3:27b"];

export function isRecommendedOllamaModel(name: string): boolean {
     const lower = name.toLowerCase();
     return RECOMMENDED_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/**
 * Build a metadata map for all local Ollama models.
 * Static metadata values override the auto-generated ones.
 */
export async function buildProviderMetadata(): Promise<Record<string, OllamaProviderMetadata>> {
     const tags = await listOllamaModels();

     const result: Record<string, OllamaProviderMetadata> = {};

     for (const tag of tags) {
          const key = tag.name;

          const auto: OllamaProviderMetadata = {
               key,
               displayName: key, // can be refined later
               sizeGB: bytesToGB(tag.size),
               description: "", // optional, we’ll override with hand-written text
               family: inferFamily(tag),
               recommended: isRecommendedOllamaModel(tag.name),
          };

          result[key] = {
               ...auto,
               // ensure required fields exist even if override omits them
               key,
               displayName: auto.displayName,
               family: auto.family,
               recommended: auto.recommended,
          };
     }

     return result;
}
//#endregion

type OllamaConfig = {
     baseUrl?: string;
     temperature?: number;
};

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export class OllamaProvider extends BaseModelProvider<ChatOllama, OllamaEmbeddings> {
     private metadata: Record<string, ProviderModelMetadata> = {};
     private metadataReady: Promise<void>;

     constructor(definition: ConfigModelProvider) {
          super(definition);
          this.metadataReady = this.populateMetadata();
     }

     private async populateMetadata() {
          try {
               this.metadata = await buildProviderMetadata();
          } catch (err) {
               console.error(`Ollama metadata build failed for ${this.id}`, err);
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
