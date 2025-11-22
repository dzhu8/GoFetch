/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Daniel Zhu 2025. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from "node:path";
import fs from "fs";
import { UIConfigField, UIConfigSections } from "@/lib/config/types";

// config file is initially nonexistent, and is created and populated at start up at run time
class ConfigManager {
     configPath: string = path.join(process.env.DATA_DIR || process.cwd(), "/data/config.json");
     configVersion = 1;
     currentConfig: any = {
          version: this.configVersion,
          setupComplete: false,
          preferences: {},
          personalization: {},
          ollama: {
               baseURL: "http://localhost:11434",
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
          ],
          personalization: [
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
                    name: "Ollama URL",
                    key: "ollamaURL",
                    fields: [
                         {
                              name: "Ollama API URL",
                              key: "ollamaURL",
                              type: "string",
                              required: false,
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
     };

     constructor() {
          this.initialize();
     }

     private initialize() {
          this.initializeConfig();
          this.initializeFromEnv();
     }

     private saveConfig() {
          // Ensure the directory exists before writing
          const configDir = path.dirname(this.configPath);
          fs.mkdirSync(configDir, { recursive: true });

          fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2));
     }

     private initializeConfig() {
          const exists = fs.existsSync(this.configPath);
          if (!exists) {
               fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2));
          } else {
               try {
                    this.currentConfig = JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
               } catch (err) {
                    if (err instanceof SyntaxError) {
                         console.error(`Error parsing config file at ${this.configPath}:`, err);
                         console.log("Loading default config and overwriting the existing file.");
                         fs.writeFileSync(this.configPath, JSON.stringify(this.currentConfig, null, 2));
                         return;
                    } else {
                         console.log("Unknown error reading config file:", err);
                    }
               }
          }
     }

     private initializeFromEnv() {
          // Load Ollama URL from env if provided
          const envOllama = process.env.OLLAMA_API_URL ?? process.env.OLLAMA_URL;
          if (envOllama) {
               if (!this.currentConfig.ollama) this.currentConfig.ollama = {};
               this.currentConfig.ollama.baseURL = envOllama;
          }

          // Map UI-config fields that declare envs for known top-level sections
          this.uiConfigSections.modelProviders?.forEach((section: any) => {
               section.fields?.forEach((f: any) => {
                    if (!f.env) return;

                    if (section.key === "ollamaURL" && !this.currentConfig.ollama?.baseURL) {
                         this.currentConfig.ollama.baseURL = process.env[f.env] ?? f.default ?? "";
                    }

                    if (section.key === "folderURI" && !this.currentConfig.folder?.path) {
                         if (!this.currentConfig.folder) this.currentConfig.folder = {};
                         this.currentConfig.folder.path = process.env[f.env] ?? f.default ?? "";
                    }
               });
          });

          this.saveConfig();
     }

     public getConfig(key: string, defaultValue?: any): any {
          const nested = key.split(".");
          let obj: any = this.currentConfig;

          for (let i = 0; i < nested.length; i++) {
               const part = nested[i];
               if (obj == null) return defaultValue;

               obj = obj[part];
          }

          return obj === undefined ? defaultValue : obj;
     }

     public isSetupComplete() {
          return this.currentConfig.setupComplete;
     }

     public markSetupComplete() {
          if (!this.currentConfig.setupComplete) {
               this.currentConfig.setupComplete = true;
          }

          this.saveConfig();
     }

     public getUIConfigSections(): UIConfigSections {
          return this.uiConfigSections;
     }

     public setOllamaURL(baseURL: string) {
          if (!this.currentConfig.ollama) this.currentConfig.ollama = {};
          this.currentConfig.ollama.baseURL = baseURL;
          this.saveConfig();
     }
}

const configManager = new ConfigManager();
export default configManager;