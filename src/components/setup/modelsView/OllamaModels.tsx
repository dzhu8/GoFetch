"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Download, Loader2, Star } from "lucide-react";
import { toast } from "sonner";

interface OllamaModel {
     name: string;
     size: string;
     description: string;
     installed: boolean;
     recommended?: boolean;
     family?: string;
}

type DownloadProgress = {
     [key: string]: {
          progress: number;
          downloaded: number;
          total: number;
     };
};

const inferFamilyFromName = (name: string): string => {
     const lower = name.toLowerCase();
     if (lower.includes("llama")) return "Llama";
     if (lower.includes("qwen")) return "Qwen";
     if (lower.includes("gemma")) return "Gemma";
     if (lower.includes("mistral")) return "Mistral";
     if (lower.includes("phi")) return "Phi";
     if (lower.includes("granite")) return "Granite";
     return "Other";
};

const formatBytes = (bytes?: number) => {
     if (!bytes || Number.isNaN(bytes)) return "0";
     return (bytes / 1024 / 1024).toFixed(1);
};

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const OllamaModels = ({ ollamaBaseUrl }: { ollamaBaseUrl?: string }) => {
     const [models, setModels] = useState<OllamaModel[]>([]);
     const [isLoading, setIsLoading] = useState(true);
     const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());
     const [downloadProgress, setDownloadProgress] = useState<DownloadProgress>({});
     const [expandedFamilies, setExpandedFamilies] = useState<Record<string, boolean>>({});

     const resolvedBaseUrl = (ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL).trim();

     const fetchModels = useCallback(async () => {
          try {
               setIsLoading(true);
               const res = await fetch(`/api/ollama/models?baseURL=${encodeURIComponent(resolvedBaseUrl)}`);
               if (!res.ok) throw new Error("Failed to fetch models");

               const data = await res.json();
               const nextModels: OllamaModel[] = data.models ?? [];
               nextModels.sort((a, b) => Number(b.recommended) - Number(a.recommended));
               setModels(nextModels);
          } catch (error) {
               console.error("Error fetching Ollama models:", error);
               toast.error("Failed to load Ollama models");
          } finally {
               setIsLoading(false);
          }
     }, [resolvedBaseUrl]);

     useEffect(() => {
          fetchModels();
     }, [fetchModels]);

     useEffect(() => {
          setExpandedFamilies((prev) => {
               const next = { ...prev };
               let changed = false;
               models.forEach((model) => {
                    const family = model.family ?? inferFamilyFromName(model.name);
                    if (next[family] === undefined) {
                         next[family] = Boolean(model.recommended);
                         changed = true;
                    }
               });
               return changed ? next : prev;
          });
     }, [models]);

     const groupedModels = useMemo(() => {
          return models.reduce<Record<string, OllamaModel[]>>((groups, model) => {
               const family = model.family ?? inferFamilyFromName(model.name);
               if (!groups[family]) groups[family] = [];
               groups[family].push(model);
               groups[family].sort((a, b) => Number(b.recommended) - Number(a.recommended));
               return groups;
          }, {});
     }, [models]);

     const families = useMemo(() => {
          return Object.keys(groupedModels).sort((a, b) => {
               const aRecommended = groupedModels[a]?.some((model) => model.recommended);
               const bRecommended = groupedModels[b]?.some((model) => model.recommended);
               if (aRecommended === bRecommended) return a.localeCompare(b);
               return aRecommended ? -1 : 1;
          });
     }, [groupedModels]);

     const toggleFamily = (family: string) => {
          setExpandedFamilies((prev) => ({
               ...prev,
               [family]: !prev[family],
          }));
     };

     const handleDownload = async (modelName: string) => {
          try {
               setDownloadingModels((prev) => new Set(prev).add(modelName));
               toast.info(`Downloading ${modelName}...`, {
                    description: "This may take a few minutes depending on the model size.",
               });

               const res = await fetch("/api/ollama/download", {
                    method: "POST",
                    headers: {
                         "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ modelName, baseURL: resolvedBaseUrl }),
               });

               if (!res.ok) {
                    const error = await res.text();
                    throw new Error(error || "Download failed");
               }

               const reader = res.body?.getReader();
               if (!reader) throw new Error("No response body");

               const decoder = new TextDecoder();
               let buffer = "";

               while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                         if (!line.trim()) continue;
                         try {
                              const data = JSON.parse(line);
                              if (data.total && data.completed !== undefined) {
                                   const progress = (data.completed / data.total) * 100;
                                   setDownloadProgress((prev) => ({
                                        ...prev,
                                        [modelName]: {
                                             progress,
                                             downloaded: data.completed,
                                             total: data.total,
                                        },
                                   }));
                              }
                         } catch (err) {
                              // swallow invalid json chunks
                         }
                    }
               }

               toast.success(`${modelName} downloaded successfully!`);
               await fetchModels();
          } catch (error) {
               console.error("Error downloading model:", error);
               toast.error(error instanceof Error ? error.message : "Failed to download model");
          } finally {
               setDownloadingModels((prev) => {
                    const next = new Set(prev);
                    next.delete(modelName);
                    return next;
               });
               setDownloadProgress((prev) => {
                    const next = { ...prev };
                    delete next[modelName];
                    return next;
               });
          }
     };

     if (isLoading) {
          return (
               <div className="flex items-center justify-center py-8 md:py-12">
                    <p className="text-xs sm:text-sm text-black/50 dark:text-white/50">Loading models...</p>
               </div>
          );
     }

     if (families.length === 0) {
          return (
               <div className="flex flex-col items-center justify-center py-8 md:py-12 text-center">
                    <p className="text-xs sm:text-sm font-medium text-black/70 dark:text-white/70">
                         No models available
                    </p>
                    <p className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 mt-1">
                         Please check your Ollama installation
                    </p>
               </div>
          );
     }

     return (
          <div className="space-y-3">
               {families.map((family) => {
                    const modelsInFamily = groupedModels[family] ?? [];
                    const isOpen = expandedFamilies[family];
                    return (
                         <div
                              key={family}
                              className="bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-xl"
                         >
                              <button
                                   type="button"
                                   onClick={() => toggleFamily(family)}
                                   className="w-full flex items-center justify-between px-4 py-3 text-left"
                              >
                                   <div>
                                        <p className="text-sm font-medium text-black dark:text-white">{family}</p>
                                        <p className="text-[11px] text-black/60 dark:text-white/60">
                                             {modelsInFamily.length} {modelsInFamily.length === 1 ? "model" : "models"}
                                        </p>
                                   </div>
                                   {isOpen ? (
                                        <ChevronDown className="w-4 h-4 text-black/60 dark:text-white/60" />
                                   ) : (
                                        <ChevronRight className="w-4 h-4 text-black/60 dark:text-white/60" />
                                   )}
                              </button>
                              {isOpen && (
                                   <div className="px-4 pb-4 space-y-3">
                                        {modelsInFamily.map((model) => {
                                             const isDownloading = downloadingModels.has(model.name);
                                             const progress = downloadProgress[model.name];
                                             const isInstalled = model.installed;
                                             return (
                                                  <div
                                                       key={model.name}
                                                       className="bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-lg p-4"
                                                  >
                                                       <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                                                            <div className="flex-1 min-w-0">
                                                                 <div className="flex items-center gap-2 flex-wrap">
                                                                      <h3 className="text-sm font-medium text-black dark:text-white">
                                                                           {model.name}
                                                                      </h3>
                                                                      {model.recommended && (
                                                                           <span className="flex items-center gap-1 text-[11px] text-yellow-600">
                                                                                <Star className="w-3.5 h-3.5 fill-yellow-500 text-yellow-500" />
                                                                                Recommended
                                                                           </span>
                                                                      )}
                                                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-light-200 dark:bg-dark-200 text-black/70 dark:text-white/70">
                                                                           {model.size}
                                                                      </span>
                                                                 </div>
                                                                 <p className="text-xs text-black/60 dark:text-white/60 mt-1 line-clamp-2">
                                                                      {model.description}
                                                                 </p>
                                                            </div>
                                                            <div className="w-full md:w-auto">
                                                                 {isInstalled ? (
                                                                      <div className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-light-200 dark:bg-dark-200 text-xs text-black/70 dark:text-white/70">
                                                                           <Check className="w-4 h-4" />
                                                                           Installed
                                                                      </div>
                                                                 ) : isDownloading && progress ? (
                                                                      <div className="w-full md:w-48">
                                                                           <div className="w-full bg-gray-200 rounded-full h-2">
                                                                                <div
                                                                                     className="bg-[#00FFB2] h-2 rounded-full transition-all duration-300"
                                                                                     style={{
                                                                                          width: `${progress.progress}%`,
                                                                                     }}
                                                                                />
                                                                           </div>
                                                                           <span className="text-[11px] text-black/70 dark:text-white/70">
                                                                                {Math.round(progress.progress)}% (
                                                                                {formatBytes(progress.downloaded)} MB /{" "}
                                                                                {formatBytes(progress.total)} MB)
                                                                           </span>
                                                                      </div>
                                                                 ) : (
                                                                      <button
                                                                           type="button"
                                                                           onClick={() => handleDownload(model.name)}
                                                                           disabled={isDownloading}
                                                                           className="w-full md:w-auto flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#00FFB2] text-white hover:bg-[#1e8fd1] active:scale-95 transition-all duration-200 text-xs font-medium disabled:bg-light-200 dark:disabled:bg-dark-200 disabled:text-black/40 dark:disabled:text-white/40 disabled:cursor-not-allowed disabled:active:scale-100"
                                                                      >
                                                                           {isDownloading ? (
                                                                                <>
                                                                                     <Loader2 className="w-4 h-4 animate-spin" />
                                                                                     Downloading...
                                                                                </>
                                                                           ) : (
                                                                                <>
                                                                                     <Download className="w-4 h-4" />
                                                                                     Download
                                                                                </>
                                                                           )}
                                                                      </button>
                                                                 )}
                                                            </div>
                                                       </div>
                                                  </div>
                                             );
                                        })}
                                   </div>
                              )}
                         </div>
                    );
               })}
          </div>
     );
};

export default OllamaModels;
