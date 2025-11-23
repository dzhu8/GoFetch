export type Model = {
     name: string;
     key: string;
};

// This type also allows for additional custom models to be configured
export type ConfigModelProvider = {
     id: string;
     name: string;
     type: string;
     chatModels: Model[];
     embeddingModels: Model[];
     config: { [key: string]: any };
     hash: string;
};

export type MinimalProvider = {
     id: string;
     name: string;
     type: string;
     chatModels: Model[];
     embeddingModels: Model[];
};

export type ModelWithProvider = {
     key: string;
     providerId: string;
};

// To allow different models to be specified for chat and embeddings
export type ModelList = {
     embedding: Model[];
     chat: Model[];
};

// All metadata fields for a model provider
export type ProviderMetadata = {
     name: string;
     key: string;
};
