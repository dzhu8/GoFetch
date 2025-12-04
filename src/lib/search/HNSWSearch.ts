import type { Buffer } from "node:buffer";
import { inArray } from "drizzle-orm";
import db from "@/server/db";
import { embeddings, folders } from "@/server/db/schema";
import configManager from "@/server";

/**
 * Configuration options for HNSW index parameters.
 *
 * @property M - Number of bi-directional links created per element during construction.
 *   Higher values lead to better recall but slower construction and more memory. Default: 32
 * @property efConstruction - Size of the dynamic candidate list during index construction.
 *   Higher values improve index quality but slow down construction. Default: 200
 * @property efSearch - Size of the dynamic candidate list during search.
 *   Higher values improve recall but slow down search. Default: 64
 * @property scoreThreshold - Minimum similarity score (0-1) for results. Only results with
 *   scores at or above this threshold are returned by searchWithThreshold. Default: 0.3
 */
export interface HNSWConfig {
     M?: number;
     efConstruction?: number;
     efSearch?: number;
     scoreThreshold?: number;
}

/**
 * Represents a single embedding record from the database.
 */
export interface EmbeddingRecord {
     id: number;
     folderName: string;
     filePath: string;
     relativePath: string;
     content: string | null;
     metadata: Record<string, unknown>;
     vector: number[];
}

/**
 * Result of a similarity search query.
 */
export interface SearchResult {
     id: number;
     folderName: string;
     filePath: string;
     relativePath: string;
     content: string | null;
     metadata: Record<string, unknown>;
     score: number;
}

/**
 * Index entry mapping internal HNSW index position to database record.
 */
interface IndexEntry {
     dbId: number;
     folderName: string;
     filePath: string;
     relativePath: string;
     content: string | null;
     metadata: Record<string, unknown>;
}

/**
 * Converts a SQLite blob buffer to a Float32 vector array.
 */
const bufferToVector = (buffer: Buffer, dim: number): number[] => {
     const floatView = new Float32Array(buffer.buffer, buffer.byteOffset, dim);
     return Array.from(floatView);
};

/**
 * HNSWSearch provides semantic similarity search using the HNSW (Hierarchical Navigable Small World)
 * algorithm via FAISS. It indexes embeddings from the database and allows efficient k-nearest
 * neighbor searches.
 *
 * @example
 * ```typescript
 * const search = new HNSWSearch({
 *   M: 32,
 *   efConstruction: 200,
 *   efSearch: 64
 * });
 *
 * // Add all folders to the index
 * await search.addAllFolders();
 *
 * // Or add specific folders
 * await search.addFolders(['my-project', 'another-project']);
 *
 * // Search for similar embeddings
 * const results = await search.search(queryVector, 10);
 * ```
 */
export class HNSWSearch {
     private index: any = null;
     private indexMap: IndexEntry[] = [];
     private dimension: number = 0;
     private isInitialized: boolean = false;
     private faissModule: any = null;

     private readonly config: Required<HNSWConfig>;

     /**
      * Default HNSW parameters providing a good balance between search quality and performance.
      */
     static readonly DEFAULT_CONFIG: Required<HNSWConfig> = {
          M: 32,
          efConstruction: 200,
          efSearch: 64,
          scoreThreshold: 0.3,
     };

     /**
      * Creates a new HNSWSearch instance with configuration from the app settings.
      * This is the recommended way to create an HNSWSearch instance as it uses
      * the user's configured HNSW parameters.
      *
      * @returns A new HNSWSearch instance configured from app settings
      */
     static fromConfig(): HNSWSearch {
          const M = configManager.getConfig("preferences.hnswM", HNSWSearch.DEFAULT_CONFIG.M);
          const efConstruction = configManager.getConfig(
               "preferences.hnswEfConstruction",
               HNSWSearch.DEFAULT_CONFIG.efConstruction
          );
          const efSearch = configManager.getConfig("preferences.hnswEfSearch", HNSWSearch.DEFAULT_CONFIG.efSearch);
          const scoreThreshold = configManager.getConfig(
               "preferences.hnswScoreThreshold",
               HNSWSearch.DEFAULT_CONFIG.scoreThreshold
          );

          return new HNSWSearch({
               M: Number(M),
               efConstruction: Number(efConstruction),
               efSearch: Number(efSearch),
               scoreThreshold: Number(scoreThreshold),
          });
     }

     /**
      * Creates a new HNSWSearch instance.
      *
      * @param config - Optional HNSW configuration parameters
      */
     constructor(config: HNSWConfig = {}) {
          this.config = {
               M: config.M ?? HNSWSearch.DEFAULT_CONFIG.M,
               efConstruction: config.efConstruction ?? HNSWSearch.DEFAULT_CONFIG.efConstruction,
               efSearch: config.efSearch ?? HNSWSearch.DEFAULT_CONFIG.efSearch,
               scoreThreshold: config.scoreThreshold ?? HNSWSearch.DEFAULT_CONFIG.scoreThreshold,
          };
     }

     /**
      * Gets the current HNSW configuration.
      */
     getConfig(): Required<HNSWConfig> {
          return { ...this.config };
     }

     /**
      * Updates the efSearch parameter. This can be changed after index construction
      * to trade off between search speed and recall.
      *
      * @param efSearch - New efSearch value
      */
     setEfSearch(efSearch: number): void {
          if (efSearch < 1) {
               throw new Error("efSearch must be at least 1");
          }
          (this.config as { efSearch: number }).efSearch = efSearch;
     }

     /**
      * Updates the score threshold parameter. This can be changed at any time
      * to adjust the minimum similarity score for threshold-based searches.
      *
      * @param scoreThreshold - New score threshold value (0-1)
      */
     setScoreThreshold(scoreThreshold: number): void {
          if (scoreThreshold < 0 || scoreThreshold > 1) {
               throw new Error("scoreThreshold must be between 0 and 1");
          }
          (this.config as { scoreThreshold: number }).scoreThreshold = scoreThreshold;
     }

     /**
      * Lazily loads the faiss-node module.
      * Uses require() to bypass Turbopack/webpack bundling of native modules.
      */
     private async loadFaiss(): Promise<any> {
          if (!this.faissModule) {
               try {
                    // Use require() instead of dynamic import to ensure the native module
                    // is loaded directly by Node.js, bypassing Turbopack bundling.
                    // The eval prevents static analysis from trying to bundle the module.
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const requireFn = typeof __webpack_require__ === "function" 
                         ? __non_webpack_require__ 
                         : require;
                    this.faissModule = requireFn("faiss-node");
               } catch (error) {
                    throw new Error(
                         "faiss-node module not found. Please install it with: npm install faiss-node\n" +
                              "Note: faiss-node requires native compilation. See https://github.com/ewfian/faiss-node for installation instructions."
                    );
               }
          }
          return this.faissModule;
     }

     /**
      * Initializes the HNSW index with the specified dimension.
      * Uses the FAISS factory pattern to create an HNSW index.
      *
      * @param dimension - Vector dimension (must match embedding dimension)
      */
     private async initializeIndex(dimension: number): Promise<void> {
          const faiss = await this.loadFaiss();

          this.dimension = dimension;

          // Use FAISS factory to create HNSW index
          // Format: "HNSW{M},Flat" for HNSW with flat storage
          // The M parameter controls the number of links per node
          const descriptor = `HNSW${this.config.M},Flat`;

          // Create HNSW index using factory pattern with L2 metric
          this.index = faiss.Index.fromFactory(dimension, descriptor, faiss.MetricType.METRIC_L2);

          this.isInitialized = true;
     }

     /**
      * Fetches embeddings from the database for the specified folders.
      *
      * @param folderNames - Array of folder names to fetch embeddings from
      * @returns Array of embedding records
      */
     private fetchEmbeddingsFromDB(folderNames: string[]): EmbeddingRecord[] {
          if (folderNames.length === 0) {
               return [];
          }

          const rows = db
               .select({
                    id: embeddings.id,
                    folderName: embeddings.folderName,
                    filePath: embeddings.filePath,
                    relativePath: embeddings.relativePath,
                    content: embeddings.content,
                    metadata: embeddings.metadata,
                    embedding: embeddings.embedding,
                    dim: embeddings.dim,
               })
               .from(embeddings)
               .where(inArray(embeddings.folderName, folderNames))
               .all();

          return rows.map((row) => ({
               id: row.id,
               folderName: row.folderName,
               filePath: row.filePath,
               relativePath: row.relativePath,
               content: row.content,
               metadata: (row.metadata as Record<string, unknown>) ?? {},
               vector: bufferToVector(row.embedding as Buffer, row.dim),
          }));
     }

     /**
      * Gets all folder names from the database.
      *
      * @returns Array of folder names
      */
     private getAllFolderNames(): string[] {
          const rows = db.select({ name: folders.name }).from(folders).all();
          return rows.map((row) => row.name);
     }

     /**
      * Adds embeddings from specified folders to the HNSW index.
      *
      * @param folderNames - Array of folder names to index
      * @returns Number of embeddings added to the index
      */
     async addFolders(folderNames: string[]): Promise<number> {
          const records = this.fetchEmbeddingsFromDB(folderNames);

          if (records.length === 0) {
               console.warn("[HNSWSearch] No embeddings found for specified folders");
               return 0;
          }

          // Initialize index if not already done
          if (!this.isInitialized) {
               const firstDim = records[0].vector.length;
               await this.initializeIndex(firstDim);
          }

          // Validate dimensions match
          const invalidRecords = records.filter((r) => r.vector.length !== this.dimension);
          if (invalidRecords.length > 0) {
               console.warn(`[HNSWSearch] Skipping ${invalidRecords.length} records with mismatched dimensions`);
          }

          const validRecords = records.filter((r) => r.vector.length === this.dimension);

          if (validRecords.length === 0) {
               return 0;
          }

          // Prepare vectors as flat number array for faiss-node
          const vectors: number[] = [];
          for (const record of validRecords) {
               vectors.push(...record.vector);
          }

          // Train the index if required (HNSW from factory needs training)
          if (!this.index.isTrained()) {
               this.index.train(vectors);
          }

          // Add vectors to index
          this.index.add(vectors);

          // Update index map
          for (const record of validRecords) {
               this.indexMap.push({
                    dbId: record.id,
                    folderName: record.folderName,
                    filePath: record.filePath,
                    relativePath: record.relativePath,
                    content: record.content,
                    metadata: record.metadata,
               });
          }

          return validRecords.length;
     }

     /**
      * Adds embeddings from all folders in the database to the HNSW index.
      *
      * @returns Number of embeddings added to the index
      */
     async addAllFolders(): Promise<number> {
          const folderNames = this.getAllFolderNames();

          if (folderNames.length === 0) {
               console.warn("[HNSWSearch] No folders found in database");
               return 0;
          }

          return this.addFolders(folderNames);
     }

     /**
      * Performs a k-nearest neighbor search using the HNSW index.
      *
      * @param queryVector - Query embedding vector
      * @param k - Number of nearest neighbors to return
      * @returns Array of search results sorted by similarity (highest first)
      */
     async search(queryVector: number[], k: number = 10): Promise<SearchResult[]> {
          if (!this.isInitialized || this.indexMap.length === 0) {
               throw new Error("Index is empty. Call addFolders() or addAllFolders() first.");
          }

          if (queryVector.length !== this.dimension) {
               throw new Error(
                    `Query vector dimension (${queryVector.length}) does not match index dimension (${this.dimension})`
               );
          }

          // Ensure k doesn't exceed index size
          const effectiveK = Math.min(k, this.indexMap.length);

          // Perform search (faiss-node expects a regular number array)
          const result = this.index.search(queryVector, effectiveK);

          // Map results back to database records
          const searchResults: SearchResult[] = [];

          for (let i = 0; i < result.labels.length; i++) {
               const idx = result.labels[i];
               const distance = result.distances[i];

               // Skip invalid indices (FAISS returns -1 for not found)
               if (idx < 0 || idx >= this.indexMap.length) {
                    continue;
               }

               const entry = this.indexMap[idx];

               // Convert L2 distance to similarity score (smaller distance = higher similarity)
               // Using exponential decay for better interpretability
               const score = Math.exp(-distance);

               searchResults.push({
                    id: entry.dbId,
                    folderName: entry.folderName,
                    filePath: entry.filePath,
                    relativePath: entry.relativePath,
                    content: entry.content,
                    metadata: entry.metadata,
                    score,
               });
          }

          // Sort by score descending (highest similarity first)
          searchResults.sort((a, b) => b.score - a.score);

          return searchResults;
     }

     /**
      * Searches for similar embeddings and returns only results from specific folders.
      *
      * @param queryVector - Query embedding vector
      * @param folderNames - Folder names to filter results by
      * @param k - Number of results to return (may search more internally for filtering)
      * @returns Array of search results from specified folders
      */
     async searchInFolders(queryVector: number[], folderNames: string[], k: number = 10): Promise<SearchResult[]> {
          // Search for more results to account for filtering
          const searchK = Math.min(k * 3, this.indexMap.length);
          const results = await this.search(queryVector, searchK);

          const folderSet = new Set(folderNames);
          const filtered = results.filter((r) => folderSet.has(r.folderName));

          return filtered.slice(0, k);
     }

     /**
      * Performs a similarity search and returns only results with scores at or above the configured threshold.
      * This is useful for returning a variable number of results based on relevance rather than a fixed k.
      *
      * @param queryVector - Query embedding vector
      * @param maxResults - Maximum number of results to return (searches this many, then filters by threshold)
      * @param threshold - Optional score threshold override (0-1). If not provided, uses the configured threshold.
      * @returns Array of search results with scores >= threshold, sorted by similarity (highest first)
      */
     async searchWithThreshold(
          queryVector: number[],
          maxResults: number = 100,
          threshold?: number
     ): Promise<SearchResult[]> {
          const scoreThreshold = threshold ?? this.config.scoreThreshold;

          // Search for maxResults candidates
          const results = await this.search(queryVector, maxResults);

          // Filter by threshold
          return results.filter((r) => r.score >= scoreThreshold);
     }

     /**
      * Searches for similar embeddings in specific folders and returns only results above the score threshold.
      *
      * @param queryVector - Query embedding vector
      * @param folderNames - Folder names to filter results by
      * @param maxResults - Maximum number of results to return before threshold filtering
      * @param threshold - Optional score threshold override (0-1). If not provided, uses the configured threshold.
      * @returns Array of search results from specified folders with scores >= threshold
      */
     async searchInFoldersWithThreshold(
          queryVector: number[],
          folderNames: string[],
          maxResults: number = 100,
          threshold?: number
     ): Promise<SearchResult[]> {
          const scoreThreshold = threshold ?? this.config.scoreThreshold;

          // Search for more results to account for filtering
          const searchK = Math.min(maxResults * 3, this.indexMap.length);
          const results = await this.search(queryVector, searchK);

          const folderSet = new Set(folderNames);
          const filtered = results.filter((r) => folderSet.has(r.folderName) && r.score >= scoreThreshold);

          return filtered.slice(0, maxResults);
     }

     /**
      * Clears the index and all associated data.
      */
     clear(): void {
          this.index = null;
          this.indexMap = [];
          this.dimension = 0;
          this.isInitialized = false;
     }

     /**
      * Rebuilds the index with new configuration parameters.
      * This is necessary to change M or efConstruction after initial construction.
      *
      * @param config - New HNSW configuration
      * @param folderNames - Optional folder names to re-index (defaults to all previously indexed folders)
      * @returns Number of embeddings in the rebuilt index
      */
     async rebuild(config?: HNSWConfig, folderNames?: string[]): Promise<number> {
          // Get unique folder names from current index if not provided
          const foldersToIndex = folderNames ?? [...new Set(this.indexMap.map((e) => e.folderName))];

          // Clear current index
          this.clear();

          // Update config if provided
          if (config) {
               if (config.M !== undefined) {
                    (this.config as { M: number }).M = config.M;
               }
               if (config.efConstruction !== undefined) {
                    (this.config as { efConstruction: number }).efConstruction = config.efConstruction;
               }
               if (config.efSearch !== undefined) {
                    (this.config as { efSearch: number }).efSearch = config.efSearch;
               }
               if (config.scoreThreshold !== undefined) {
                    (this.config as { scoreThreshold: number }).scoreThreshold = config.scoreThreshold;
               }
          }

          // Rebuild index
          return this.addFolders(foldersToIndex);
     }

     /**
      * Gets statistics about the current index.
      */
     getStats(): {
          isInitialized: boolean;
          dimension: number;
          totalVectors: number;
          config: Required<HNSWConfig>;
          folderCounts: Record<string, number>;
     } {
          const folderCounts: Record<string, number> = {};
          for (const entry of this.indexMap) {
               folderCounts[entry.folderName] = (folderCounts[entry.folderName] ?? 0) + 1;
          }

          return {
               isInitialized: this.isInitialized,
               dimension: this.dimension,
               totalVectors: this.indexMap.length,
               config: this.getConfig(),
               folderCounts,
          };
     }

     /**
      * Checks if the index has been initialized and contains vectors.
      */
     isReady(): boolean {
          return this.isInitialized && this.indexMap.length > 0;
     }
}

export default HNSWSearch;
