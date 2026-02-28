/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Daniel Zhu 2025. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from "node:path";
import fs from "fs";
//import { inspect } from "node:util";
import { UIConfigSections } from "@/lib/config/types";
import { ConfigModelProvider } from "@/lib/models/types";
import { eq } from "drizzle-orm";
import db from "@/server/db";
import { appSettings } from "@/server/db/schema";

// Cache invalidation time in milliseconds (5 seconds for faster dev experience)
const CONFIG_CACHE_TTL = 5000;

// config file is initially nonexistent, and is created and populated at start up at run time
class ConfigManager {
     configPath: string = path.join(process.env.DATA_DIR || process.cwd(), "/data/config.json");
     configVersion = 1;
     private lastRefreshTime = 0;
     currentConfig: any = {
          version: this.configVersion,
          setupComplete: false,
          preferences: {
               embedSummaries: false,
               defaultChatModel: null,
               defaultEmbeddingModel: null,
               embeddingPointSize: "5",
               hnswM: 32,
               hnswEfConstruction: 200,
               hnswEfSearch: 64,
               hnswScoreThreshold: 0.3,
               textChunkMaxTokens: 1000,
               textChunkOverlapTokens: 100,
          },
          personalization: {
               graphConstructionMethod: "snowball",
          },
          modelProviders: [],
          ollama: {
               baseURL: "http://localhost:11434",
          },
          search: {
               searxngURL: "",
          },
          // Optional initial folder to register at startup
          folder: {
               path: "",
          },
     };
     uiConfigSections: UIConfigSections = {
          preferences: [
               {
                    name: "Theme",
                    key: "theme",
                    type: "select",
                    options: [
                         { name: "Light", value: "light" },
                         { name: "Dark", value: "dark" },
                    ],
                    required: false,
                    description: "Choose between light and dark layouts for the app.",
                    default: "dark",
                    scope: "client",
               },
               {
                    name: "Embed Summaries",
                    key: "embedSummaries",
                    type: "switch",
                    required: false,
                    description:
                         "Use a chat model to summarize code snippets before embedding. Improves search quality but takes longer.",
                    default: false,
                    scope: "server",
               },
               {
                    name: "Embedding Dot Size",
                    key: "embeddingPointSize",
                    type: "select",
                    options: [
                         { name: "Small", value: "3" },
                         { name: "Medium", value: "5" },
                         { name: "Large", value: "8" },
                    ],
                    required: false,
                    description: "Controls the size of 3D scatter markers in the Inspect view.",
                    default: "5",
                    scope: "client",
               },
               {
                    name: "HNSW M (Links per Node)",
                    key: "hnswM",
                    type: "number",
                    required: false,
                    description:
                         "Number of bi-directional links per node in the HNSW graph. Higher values improve recall but increase memory and construction time.",
                    default: 32,
                    min: 4,
                    max: 128,
                    placeholder: "32",
                    scope: "server",
               },
               {
                    name: "HNSW efConstruction",
                    key: "hnswEfConstruction",
                    type: "number",
                    required: false,
                    description:
                         "Size of the dynamic candidate list during index construction. Higher values improve index quality but slow construction.",
                    default: 200,
                    min: 16,
                    max: 1000,
                    placeholder: "200",
                    scope: "server",
               },
               {
                    name: "HNSW efSearch",
                    key: "hnswEfSearch",
                    type: "number",
                    required: false,
                    description:
                         "Size of the dynamic candidate list during search. Higher values improve recall but slow down search.",
                    default: 64,
                    min: 16,
                    max: 512,
                    placeholder: "64",
                    scope: "server",
               },
               {
                    name: "HNSW Score Threshold",
                    key: "hnswScoreThreshold",
                    type: "number",
                    required: false,
                    description:
                         "Minimum similarity score (0-1) for search results. Only results with scores at or above this threshold are returned when using threshold-based search.",
                    default: 0.3,
                    min: 0,
                    max: 1,
                    step: 0.05,
                    placeholder: "0.3",
                    scope: "server",
               },
               {
                    name: "Text Chunk Max Tokens",
                    key: "textChunkMaxTokens",
                    type: "number",
                    required: false,
                    description:
                         "Maximum number of tokens per chunk when splitting text files for embedding. Lower values create more granular chunks.",
                    default: 1000,
                    min: 100,
                    max: 4000,
                    placeholder: "1000",
                    scope: "server",
               },
               {
                    name: "Text Chunk Overlap Tokens",
                    key: "textChunkOverlapTokens",
                    type: "number",
                    required: false,
                    description: "Number of overlapping tokens between consecutive chunks for context continuity.",
                    default: 100,
                    min: 0,
                    max: 500,
                    placeholder: "100",
                    scope: "server",
               },
          ],
          personalization: [
               {
                    name: "Related Papers Discovery Method",
                    key: "graphConstructionMethod",
                    type: "select",
                    options: [{ name: "Snowball (Default)", value: "snowball" }],
                    required: false,
                    description:
                         "Select the algorithm used to discover and rank related papers based on citations. Snowball uses depth-1 references and citations to build a candidate pool and ranks by bibliographic coupling and co-citation.",
                    default: "snowball",
                    scope: "server",
               },
               {
                    name: "System Instructions",
                    key: "systemInstructions",
                    type: "textarea",
                    required: false,
                    description: "Add custom behavior or tone for the model.",
                    placeholder:
                         'e.g., "Respond in a friendly and concise tone" or "Use British English and format answers as bullet points."',
                    scope: "client",
               },
          ],
          // Ollama-specific UI config
          // placed at top-level so no model-provider generic UI is required
          modelProviders: [
               {
                    name: "Ollama",
                    key: "ollama",
                    fields: [
                         {
                              name: "Base URL",
                              key: "baseURL",
                              type: "string",
                              required: true,
                              description: "The base URL for your Ollama instance",
                              placeholder: "http://localhost:11434",
                              default: "http://localhost:11434",
                              scope: "server",
                              env: "OLLAMA_API_URL",
                         },
                    ],
               },
          ],
          folders: [
               {
                    name: "Initial Folder",
                    key: "folderURI",
                    fields: [
                         {
                              name: "Initial Folder URI",
                              key: "folderURI",
                              type: "string",
                              required: false,
                              description: "Optional initial folder path to register at startup",
                              placeholder: "C:\\path\\to\\folder or file:///C:/path",
                              default: "",
                              scope: "server",
                              env: "INITIAL_FOLDER",
                         },
                    ],
               },
          ],
          search: [
               {
                    name: "SearXNG URL",
                    key: "search.searxngURL",
                    type: "string" as const,
                    required: false,
                    description: "URL of your SearXNG instance for academic web search",
                    placeholder: "http://localhost:8080",
                    default: "",
                    scope: "server" as const,
                    env: "SEARXNG_API_URL",
               },
          ],
     };

     constructor() {
          this.initialize();
     }

     private initialize() {
          this.initializeConfig();
          //this.loadSettingsFromDatabase();
          this.initializeFromEnv();
     }

     private refreshConfigFromDisk(): void {
          // Skip refresh if within cache TTL to reduce disk I/O
          const now = Date.now();
          if (now - this.lastRefreshTime < CONFIG_CACHE_TTL) {
               return;
          }
          this.lastRefreshTime = now;

          this.syncConfigFromDisk();
          //this.loadSettingsFromDatabase({ persistToDisk: false });
     }

     private saveConfig() {
          // Ensure the directory exists before writing
          const configDir = path.dirname(this.configPath);
          fs.mkdirSync(configDir, { recursive: true });

          fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2));
     }

     private initializeConfig() {
          this.syncConfigFromDisk();
     }

     private syncConfigFromDisk(): void {
          const exists = fs.existsSync(this.configPath);
          if (!exists) {
               this.saveConfig();
               return;
          }

          try {
               this.currentConfig = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
               this.ensureConfigShape();
          } catch (err) {
               if (err instanceof SyntaxError) {
                    console.error(`Error parsing config file at ${this.configPath}:`, err);
                    console.log("Loading default config and overwriting the existing file.");
                    this.saveConfig();
               } else {
                    console.log("Unknown error reading config file:", err);
               }
          }
     }

     private ensureConfigShape(): void {
          if (!Array.isArray(this.currentConfig.modelProviders)) {
               this.currentConfig.modelProviders = [];
          } else {
               // Ensure each provider has an ocrModels array
               this.currentConfig.modelProviders.forEach((p: any) => {
                    if (!Array.isArray(p.ocrModels)) {
                         p.ocrModels = [];
                    }
               });
          }
          if (!this.currentConfig.preferences || typeof this.currentConfig.preferences !== "object") {
               this.currentConfig.preferences = {};
          }
          if (!this.currentConfig.personalization || typeof this.currentConfig.personalization !== "object") {
               this.currentConfig.personalization = {};
          }
          if (this.currentConfig.personalization.graphConstructionMethod === undefined) {
               this.currentConfig.personalization.graphConstructionMethod = "snowball";
          }
          if (this.currentConfig.preferences.cliFolderWatcher === undefined) {
               this.currentConfig.preferences.cliFolderWatcher = false;
          }
          if (this.currentConfig.preferences.defaultChatModel === undefined) {
               this.currentConfig.preferences.defaultChatModel = null;
          }
          if (this.currentConfig.preferences.defaultEmbeddingModel === undefined) {
               this.currentConfig.preferences.defaultEmbeddingModel = null;
          }
          if (this.currentConfig.preferences.embeddingPointSize === undefined) {
               this.currentConfig.preferences.embeddingPointSize = "5";
          }
          if (this.currentConfig.preferences.hnswM === undefined) {
               this.currentConfig.preferences.hnswM = 32;
          }
          if (this.currentConfig.preferences.hnswEfConstruction === undefined) {
               this.currentConfig.preferences.hnswEfConstruction = 200;
          }
          if (this.currentConfig.preferences.hnswEfSearch === undefined) {
               this.currentConfig.preferences.hnswEfSearch = 64;
          }
          if (this.currentConfig.preferences.hnswScoreThreshold === undefined) {
               this.currentConfig.preferences.hnswScoreThreshold = 0.3;
          }
          if (this.currentConfig.preferences.textChunkMaxTokens === undefined) {
               this.currentConfig.preferences.textChunkMaxTokens = 1000;
          }
          if (this.currentConfig.preferences.textChunkOverlapTokens === undefined) {
               this.currentConfig.preferences.textChunkOverlapTokens = 100;
          }
          if (!this.currentConfig.search || typeof this.currentConfig.search !== "object") {
               this.currentConfig.search = {};
          }
          if (this.currentConfig.search.searxngURL === undefined) {
               this.currentConfig.search.searxngURL = "";
          }
     }

     private ensureModelProvidersArray() {
          if (!Array.isArray(this.currentConfig.modelProviders)) {
               this.currentConfig.modelProviders = [];
          }
     }

     private initializeFromEnv() {
          // Load Ollama URL from env if provided
          const envOllama = process.env.OLLAMA_API_URL ?? process.env.OLLAMA_URL;
          if (envOllama) {
               this.applyConfigValue("ollama.baseURL", envOllama);
               this.persistSettingToDatabase("ollama.baseURL", envOllama);
          }

          // Load SearXNG URL from env if provided
          const envSearxng = process.env.SEARXNG_API_URL;
          if (envSearxng) {
               this.applyConfigValue("search.searxngURL", envSearxng);
               this.persistSettingToDatabase("search.searxngURL", envSearxng);
          }

          // Map UI-config fields that declare envs for known top-level sections
          this.uiConfigSections.modelProviders?.forEach((section: any) => {
               section.fields?.forEach((f: any) => {
                    if (!f.env) return;

                    if (section.key === "ollamaURL" && !this.currentConfig.ollama?.baseURL) {
                         const value = process.env[f.env] ?? f.default ?? "";
                         this.applyConfigValue("ollama.baseURL", value);
                         this.persistSettingToDatabase("ollama.baseURL", value);
                    }

                    if (section.key === "folderURI" && !this.currentConfig.folder?.path) {
                         const value = process.env[f.env] ?? f.default ?? "";
                         this.applyConfigValue("folder.path", value);
                         this.persistSettingToDatabase("folder.path", value);
                    }
               });
          });

          this.saveConfig();
     }

     private loadSettingsFromDatabase(options?: { persistToDisk?: boolean }): boolean {
          const shouldPersist = options?.persistToDisk ?? true;
          try {
               const rows = db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings).all();
               // if (rows.length === 0) {
               //      console.log("[configManager] Settings table snapshot: <empty>");
               // } else {
               //      console.log(`[configManager] Settings table snapshot (${rows.length} rows):`);
               //      rows.forEach(({ key, value }) => {
               //           console.log(`    - ${key}: ${formatSettingValue(value)}`);
               //      });
               // }
               if (rows.length === 0) {
                    return false;
               }

               rows.forEach(({ key, value }) => {
                    if (value === undefined) {
                         return;
                    }
                    this.applyConfigValue(key, value);
               });

               if (shouldPersist) {
                    this.saveConfig();
               }

               return true;
          } catch (error) {
               if (this.isSettingsTableMissing(error)) {
                    return false;
               }
               console.error("[configManager] Failed to load settings from database:", error);
               return false;
          }
     }

     private persistSettingToDatabase(key: string, value: any): void {
          try {
               if (value === undefined) {
                    db.delete(appSettings).where(eq(appSettings.key, key)).run();
                    return;
               }

               const existing = db
                    .select({ key: appSettings.key })
                    .from(appSettings)
                    .where(eq(appSettings.key, key))
                    .get();

               const payload = { value, updatedAt: new Date().toISOString() };

               if (existing) {
                    db.update(appSettings).set(payload).where(eq(appSettings.key, key)).run();
               } else {
                    db.insert(appSettings)
                         .values({ key, ...payload })
                         .run();
               }
          } catch (error) {
               if (this.isSettingsTableMissing(error)) {
                    return;
               }
               console.error(`[configManager] Failed to persist setting ${key}:`, error);
          }
     }

     private applyConfigValue(key: string, value: any): void {
          const nested = key.split(".");
          let obj: any = this.currentConfig;

          for (let i = 0; i < nested.length - 1; i++) {
               const part = nested[i];
               if (obj[part] == null || typeof obj[part] !== "object") {
                    obj[part] = {};
               }
               obj = obj[part];
          }

          const finalKey = nested[nested.length - 1];
          obj[finalKey] = value;
     }

     private isSettingsTableMissing(error: unknown): boolean {
          return error instanceof Error && /no such table: app_settings/i.test(error.message);
     }

     public getConfig(key: string, defaultValue?: any): any {
          this.refreshConfigFromDisk();
          const nested = key.split(".");
          let obj: any = this.currentConfig;

          for (let i = 0; i < nested.length; i++) {
               const part = nested[i];
               if (obj == null) return defaultValue;

               obj = obj[part];
          }

          return obj === undefined ? defaultValue : obj;
     }

     public getAllConfig(): any {
          this.refreshConfigFromDisk();
          return JSON.parse(JSON.stringify(this.currentConfig));
     }

     public updateConfig(key: string, value: any): void {
          this.applyConfigValue(key, value);
          this.saveConfig();
          this.persistSettingToDatabase(key, value);
     }

     public isSetupComplete() {
          this.refreshConfigFromDisk();
          return this.currentConfig.setupComplete;
     }

     public markSetupComplete() {
          if (!this.currentConfig.setupComplete) {
               this.currentConfig.setupComplete = true;
          }

          this.saveConfig();
          this.persistSettingToDatabase("setupComplete", this.currentConfig.setupComplete);
     }

     public getUIConfigSections(): UIConfigSections {
          return this.uiConfigSections;
     }

     public setOllamaURL(baseURL: string) {
          this.applyConfigValue("ollama.baseURL", baseURL);
          this.saveConfig();
          this.persistSettingToDatabase("ollama.baseURL", baseURL);
     }

     public getModelProviders(): ConfigModelProvider[] {
          this.refreshConfigFromDisk();
          this.ensureModelProvidersArray();
          return this.currentConfig.modelProviders;
     }

     public setModelProviders(providers: ConfigModelProvider[]): void {
          this.currentConfig.modelProviders = providers;
          this.saveConfig();
          this.persistSettingToDatabase("modelProviders", providers);
     }
}

const configManager = new ConfigManager();
export default configManager;

// function formatSettingValue(value: unknown): string {
//      try {
//           return inspect(value, { depth: null, breakLength: 120, compact: false });
//      } catch (error) {
//           const message = error instanceof Error ? error.message : String(error);
//           return `[unserializable value: ${message}]`;
//      }
// }
