import { ConfigModelProvider, EmbeddingModelClient, MinimalProvider, ModelList } from "@/lib/models/types";
import { AnthropicProvider } from "@/lib/models/providers/AnthropicProvider";
import { BaseModelProvider } from "@/lib/models/providers/BaseModelProvider";
import { OllamaProvider } from "@/lib/models/providers/OllamaProvider";
import { OpenAIProvider } from "@/lib/models/providers/OpenAIProvider";
import { getConfiguredModelProviders, setConfiguredModelProviders } from "./serverRegistry";

type ProviderFactory = new (config: ConfigModelProvider) => BaseModelProvider;

const providerFactories: Record<string, ProviderFactory> = {
     openai: OpenAIProvider,
     anthropic: AnthropicProvider,
     ollama: OllamaProvider,
};

export type RegisteredProvider<
     TChat = unknown,
     TEmbedding extends EmbeddingModelClient = EmbeddingModelClient,
> = ConfigModelProvider & {
     provider: BaseModelProvider<TChat, TEmbedding>;
};

export class ModelRegistry {
     activeProviders: RegisteredProvider[] = [];

     constructor() {
          this.initializeActiveProviders();
          this.debugEmbeddingRegistration("qwen3-embedding:8b");
     }

     private initializeActiveProviders() {
          const configuredProviders = getConfiguredModelProviders();
          this.activeProviders = configuredProviders
               .map((config) => this.createProvider(config))
               .filter((config): config is RegisteredProvider => Boolean(config));
     }

     private debugEmbeddingRegistration(modelKey: string) {
          const provider = this.activeProviders.find((registered) =>
               registered.embeddingModels?.some((model) => model.key === modelKey)
          );

          if (provider) {
               console.log(
                    `[ModelRegistry] Found embedding model ${modelKey} on provider ${provider.id} (${provider.name}).`
               );
          } else {
               console.warn(
                    `[ModelRegistry] Embedding model ${modelKey} is not registered on any provider at startup.`
               );
          }
     }

     private createProvider(config: ConfigModelProvider): RegisteredProvider | null {
          const factory = providerFactories[config.type?.toLowerCase?.() ?? ""];

          if (!factory) {
               console.warn(`Unsupported provider type: ${config.type}`);
               return null;
          }

          try {
               const provider = new factory(config);
               return { ...config, provider };
          } catch (error) {
               console.error(`Failed to initialize provider ${config.id}`, error);
               return null;
          }
     }

     getProviders(): RegisteredProvider[] {
          return this.activeProviders;
     }

     async getActiveProviders(): Promise<MinimalProvider[]> {
          const providers: MinimalProvider[] = [];

          await Promise.all(
               this.activeProviders.map(async (registered) => {
                    let modelList: ModelList = { chat: [], embedding: [] };

                    try {
                         modelList = await registered.provider.getModelList();
                    } catch (error: any) {
                         const message = error?.message ?? "Unknown error retrieving model list";
                         console.error(
                              `Failed to get model list. Type: ${registered.type}, ID: ${registered.id}, Error: ${message}`
                         );
                         modelList = {
                              chat: [
                                   {
                                        key: "error",
                                        name: message,
                                   },
                              ],
                              embedding: [],
                         };
                    }

                    providers.push({
                         id: registered.id,
                         name: registered.name,
                         type: registered.type,
                         chatModels: modelList.chat,
                         embeddingModels: modelList.embedding,
                    });
               })
          );

          return providers;
     }

     getProviderById(id: string): RegisteredProvider | undefined {
          return this.activeProviders.find((provider) => provider.id === id);
     }

     addProvider(config: ConfigModelProvider): RegisteredProvider {
          if (this.getProviderById(config.id)) {
               throw new Error(`Provider with id ${config.id} already exists.`);
          }

          const instance = this.createProvider(config);

          if (!instance) {
               throw new Error(`Unable to create provider for type ${config.type}.`);
          }

          this.activeProviders.push(instance);
          this.persistProviders();
          return instance;
     }

     updateProvider(config: ConfigModelProvider): RegisteredProvider {
          const index = this.activeProviders.findIndex((provider) => provider.id === config.id);

          if (index === -1) {
               throw new Error(`Provider with id ${config.id} does not exist.`);
          }

          const instance = this.createProvider(config);

          if (!instance) {
               throw new Error(`Unable to update provider for type ${config.type}.`);
          }

          this.activeProviders[index] = instance;
          this.persistProviders();
          return instance;
     }

     removeProvider(id: string): void {
          this.activeProviders = this.activeProviders.filter((provider) => provider.id !== id);
          this.persistProviders();
     }

     private persistProviders(): void {
          const configs = this.activeProviders.map(({ provider: _provider, ...rest }) => rest as ConfigModelProvider);
          setConfiguredModelProviders(configs);
     }
}

const modelRegistry = new ModelRegistry();

export default modelRegistry;
