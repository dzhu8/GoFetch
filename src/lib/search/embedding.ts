// Lazy load server modules to avoid better-sqlite3 being bundled
function getModelRegistry() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/providerRegistry").default;
}
function getConfigManager() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/index").default;
}

// Helper to get query embedding using the configured default model
export async function embedQuery(query: string): Promise<number[]> {
     const configManager = getConfigManager();
     const defaultEmbeddingModel = configManager.getConfig("preferences.defaultEmbeddingModel");

     if (!defaultEmbeddingModel) {
          throw new Error("No default embedding model configured");
     }

     const { providerId, modelKey } =
          typeof defaultEmbeddingModel === "object" ? defaultEmbeddingModel : { providerId: null, modelKey: null };

     if (!providerId || !modelKey) {
          throw new Error("Invalid default embedding model configuration");
     }

     const modelRegistry = getModelRegistry();
     const provider = modelRegistry.getProviderById(providerId);
     if (!provider) {
          throw new Error(`Provider ${providerId} not found`);
     }

     const embeddingClient = await provider.provider.loadEmbeddingModel(modelKey);
     const [vector] = await embeddingClient.embedDocuments([query]);

     return vector;
}
