import { ConfigModelProvider, EmbeddingModelClient, Model, ModelList } from "@/lib/models/types";

export type ProviderModelMetadata = {
     key: string;
     displayName?: string;
     parameters?: number;
     sizeGB?: number;
     contextWindow?: number;
     description?: string;
};

export abstract class BaseModelProvider<
     ChatModel = unknown,
     EmbeddingModel extends EmbeddingModelClient = EmbeddingModelClient,
> {
     constructor(protected readonly definition: ConfigModelProvider) {}

     protected get config() {
          return this.definition.config;
     }

     get id(): string {
          return this.definition.id;
     }

     get name(): string {
          return this.definition.name;
     }

     abstract getAvailableChatModels(): Model[];
     abstract getAvailableEmbeddingModels(): Model[];
     abstract getAvailableOCRModels(): Model[];
     abstract loadChatModel(modelKey: string): Promise<ChatModel>;
     abstract loadEmbeddingModel(modelKey: string): Promise<EmbeddingModel>;
     abstract loadOCRModel(modelKey: string): Promise<any>;

     getModelMetadata(_modelKey: string): ProviderModelMetadata | undefined {
          return undefined;
     }

     async getModelList(): Promise<ModelList> {
          return {
               chat: this.getAvailableChatModels(),
               embedding: this.getAvailableEmbeddingModels(),
               ocr: this.getAvailableOCRModels(),
          };
     }

     protected assertModelConfigured(modelKey: string, models: Model[]): void {
          if (!models.some((model) => model.key === modelKey)) {
               throw new Error(`Model ${modelKey} is not configured for provider ${this.name}.`);
          }
     }
}
