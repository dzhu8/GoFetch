"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Download, Loader2, RefreshCcw, X } from "lucide-react";
import { toast } from "sonner";
import Image from "next/image";
import GoFetchDog from "@/assets/GoFetch-dog-1.svg";
import type { MinimalProvider } from "@/lib/models/types";
import { cn } from "@/lib/utils";

interface NormalizedModelRow {
     key: string;
     displayName: string;
     description?: string;
     sizeLabel: string;
     contextWindowLabel: string;
     parameterLabel: string;
     supportsChat: boolean;
     supportsEmbedding: boolean;
     action: "download" | "remote";
     recommended?: boolean;
     installed?: boolean;
}

const DEFAULT_TEXT_SAMPLE_A = "Explain how a solar eclipse happens.";
const DEFAULT_TEXT_SAMPLE_B = "Describe the way the moon briefly blocks the sun during an eclipse.";

type TestModalConfig = {
     providerId: string;
     providerName: string;
     modelKey: string;
     modelName: string;
};

const TEST_TABS = [
     { id: "text", label: "Text" },
     { id: "code", label: "Code" },
] as const;

type TestTabId = (typeof TEST_TABS)[number]["id"];

const deriveParameterLabelFromName = (value?: string) => {
     if (!value) return "—";

     // First try to match after the colon
     const afterColon = value.split(":").pop() ?? "";
     const colonMatch = afterColon.match(/^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[bm])/i);
     if (colonMatch?.groups) {
          const unit = colonMatch.groups.unit?.toUpperCase();
          return `${colonMatch.groups.amount}${unit}`;
     }

     // Fallback: match anywhere in the string
     const match = value.match(/(?<amount>\d+(?:\.\d+)?)\s*(?<unit>[bm])/i);
     if (!match || !match.groups) return "—";
     const unit = match.groups.unit?.toUpperCase();
     return `${match.groups.amount}${unit}`;
};

const formatSizeLabel = (value?: string) => {
     if (!value || !value.trim()) return "—";
     return value;
};

const capabilityBadgeClasses = (value: boolean) =>
     value
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200"
          : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200";

type DownloadProgressState = {
     progress: number;
     downloaded: number;
     total: number;
};

const formatMegabytes = (bytes?: number) => {
     if (!bytes || Number.isNaN(bytes)) {
          return "0";
     }
     return (bytes / 1024 / 1024).toFixed(1);
};

const ModelsPage = () => {
     const [providers, setProviders] = useState<MinimalProvider[]>([]);
     const [providerModels, setProviderModels] = useState<Record<string, NormalizedModelRow[]>>({});
     const [isLoadingProviders, setIsLoadingProviders] = useState(true);
     const [providerLoadingState, setProviderLoadingState] = useState<Record<string, boolean>>({});
     const [errorMessage, setErrorMessage] = useState<string | null>(null);
     const [downloadingMap, setDownloadingMap] = useState<Record<string, boolean>>({});
     const [downloadProgressMap, setDownloadProgressMap] = useState<Record<string, DownloadProgressState>>({});
     const [activeTestConfig, setActiveTestConfig] = useState<TestModalConfig | null>(null);

     const providerLookup = useMemo(() => {
          const map = new Map<string, MinimalProvider>();
          providers.forEach((provider) => map.set(provider.id, provider));
          return map;
     }, [providers]);

     const registerModelWithProvider = useCallback(async (providerId: string, model: NormalizedModelRow) => {
          const providersRes = await fetch("/api/providers", { cache: "no-store" });
          if (!providersRes.ok) {
               throw new Error("Failed to load provider configuration");
          }

          const data = await providersRes.json().catch(() => ({}));
          const providerList = (data?.providers ?? []) as MinimalProvider[];
          const provider = providerList.find((entry) => entry.id === providerId);

          if (!provider) {
               throw new Error("Provider not found. Please refresh and try again.");
          }

          const chatModels = Array.isArray(provider.chatModels) ? [...provider.chatModels] : [];
          const embeddingModels = Array.isArray(provider.embeddingModels) ? [...provider.embeddingModels] : [];
          let updated = false;
          const displayName = model.displayName || model.key;

          if (model.supportsChat && !chatModels.some((item) => item.key === model.key)) {
               chatModels.push({ key: model.key, name: displayName });
               updated = true;
          }

          if (model.supportsEmbedding && !embeddingModels.some((item) => item.key === model.key)) {
               embeddingModels.push({ key: model.key, name: displayName });
               updated = true;
          }

          if (!updated) {
               return;
          }

          const patchRes = await fetch(`/api/providers/${providerId}`, {
               method: "PATCH",
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify({ chatModels, embeddingModels }),
          });

          if (!patchRes.ok) {
               const error = await patchRes.json().catch(() => ({}));
               throw new Error(error?.message || "Failed to update provider configuration");
          }

          setProviders((prev) =>
               prev.map((existing) =>
                    existing.id === providerId ? { ...existing, chatModels, embeddingModels } : existing
               )
          );
     }, []);

     const loadModelsForProvider = useCallback(
          async (provider: MinimalProvider | undefined, options?: { suppressSpinner?: boolean }) => {
               if (!provider?.id) return;
               const providerType = provider.type?.toLowerCase?.() ?? "";

               if (!options?.suppressSpinner) {
                    setProviderLoadingState((prev) => ({ ...prev, [provider.id]: true }));
               }

               try {
                    if (providerType === "ollama") {
                         const res = await fetch(`/api/ollama/models?providerId=${provider.id}`, { cache: "no-store" });
                         if (!res.ok) throw new Error("Failed to load Ollama models");
                         const data = await res.json();
                         const rows: NormalizedModelRow[] = (data.models ?? []).map((model: any) => ({
                              key: model.name,
                              displayName: model.name,
                              description: model.description,
                              sizeLabel: formatSizeLabel(model.size),
                              contextWindowLabel: model.contextWindow ?? "—",
                              parameterLabel: deriveParameterLabelFromName(model.name),
                              supportsChat: Boolean(model.supportsChat),
                              supportsEmbedding: Boolean(model.supportsEmbedding),
                              action: "download",
                              recommended: Boolean(model.recommended),
                              installed: Boolean(model.installed),
                         }));
                         setProviderModels((prev) => ({ ...prev, [provider.id]: rows }));
                         return;
                    }

                    const res = await fetch(`/api/providers/${provider.id}/models`, { cache: "no-store" });
                    if (!res.ok) throw new Error("Failed to load provider models");
                    const data = await res.json();
                    const rows: NormalizedModelRow[] = (data.models ?? []).map((model: any) => ({
                         key: model.key,
                         displayName: model.displayName ?? model.name ?? model.key,
                         description: model.description,
                         sizeLabel: model.sizeLabel ?? "—",
                         contextWindowLabel: model.contextWindow ?? "—",
                         parameterLabel:
                              model.parameterLabel ??
                              deriveParameterLabelFromName(model.displayName ?? model.name ?? model.key),
                         supportsChat: Boolean(model.supportsChat),
                         supportsEmbedding: Boolean(model.supportsEmbedding),
                         action: "remote",
                    }));
                    setProviderModels((prev) => ({ ...prev, [provider.id]: rows }));
               } catch (error) {
                    console.error(`Failed to load models for ${provider.name}`, error);
                    toast.error(`Unable to load models for ${provider.name}`);
                    setProviderModels((prev) => ({ ...prev, [provider.id]: [] }));
               } finally {
                    if (!options?.suppressSpinner) {
                         setProviderLoadingState((prev) => ({ ...prev, [provider.id]: false }));
                    }
               }
          },
          []
     );

     const fetchProviders = useCallback(async () => {
          try {
               setIsLoadingProviders(true);
               setErrorMessage(null);
               const res = await fetch("/api/providers", { cache: "no-store" });
               if (!res.ok) throw new Error("Failed to fetch providers");
               const data = await res.json();
               const list = (data.providers ?? []) as MinimalProvider[];
               list.sort((a, b) => a.name.localeCompare(b.name));
               setProviders(list);
               setProviderModels({});
               await Promise.all(list.map((provider) => loadModelsForProvider(provider)));
          } catch (error) {
               console.error("Failed to fetch providers", error);
               setErrorMessage("Unable to load providers. Please try again.");
               toast.error("Unable to load providers");
          } finally {
               setIsLoadingProviders(false);
          }
     }, [loadModelsForProvider]);

     useEffect(() => {
          void fetchProviders();
     }, [fetchProviders]);

     const totalModels = useMemo(() => {
          return Object.values(providerModels).reduce((total, models) => total + (models?.length ?? 0), 0);
     }, [providerModels]);

     const handleDownload = useCallback(
          async (providerId: string, model: NormalizedModelRow) => {
               const provider = providerLookup.get(providerId);
               if (!provider) {
                    toast.error("Provider not found. Please refresh and try again.");
                    return;
               }

               const key = `${providerId}:${model.key}`;
               setDownloadingMap((prev) => ({ ...prev, [key]: true }));
               setDownloadProgressMap((prev) => ({
                    ...prev,
                    [key]: { progress: 0, downloaded: 0, total: 0 },
               }));

               toast.info(`Downloading ${model.displayName}...`, {
                    description: "This may take a few minutes depending on the model size.",
               });

               try {
                    const res = await fetch("/api/ollama/download", {
                         method: "POST",
                         headers: { "Content-Type": "application/json" },
                         body: JSON.stringify({ modelName: model.key }),
                    });

                    if (!res.ok) {
                         const errorText = await res.text().catch(() => "");
                         throw new Error(errorText || "Download failed");
                    }

                    const reader = res.body?.getReader();
                    if (!reader) {
                         throw new Error("Unable to read download stream");
                    }

                    const decoder = new TextDecoder();
                    let buffer = "";

                    while (true) {
                         const { done, value } = await reader.read();
                         if (done) break;
                         buffer += decoder.decode(value, { stream: true });
                         const lines = buffer.split("\n");
                         buffer = lines.pop() ?? "";

                         for (const line of lines) {
                              const trimmed = line.trim();
                              if (!trimmed) continue;
                              try {
                                   const payload = JSON.parse(trimmed);
                                   if (
                                        typeof payload.total === "number" &&
                                        typeof payload.completed === "number" &&
                                        payload.total > 0
                                   ) {
                                        const progressPercent = Math.min(
                                             (payload.completed / payload.total) * 100,
                                             100
                                        );
                                        setDownloadProgressMap((prev) => ({
                                             ...prev,
                                             [key]: {
                                                  progress: progressPercent,
                                                  downloaded: payload.completed,
                                                  total: payload.total,
                                             },
                                        }));
                                   }
                              } catch {
                                   // Ignore partial JSON chunks until they are complete
                              }
                         }
                    }

                    toast.success(`${model.displayName} downloaded successfully`);
                    await registerModelWithProvider(providerId, model);
                    await loadModelsForProvider(provider, { suppressSpinner: true });
               } catch (error) {
                    console.error("Download failed", error);
                    toast.error(error instanceof Error ? error.message : "Failed to download model");
               } finally {
                    setDownloadingMap((prev) => {
                         const next = { ...prev };
                         delete next[key];
                         return next;
                    });
                    setDownloadProgressMap((prev) => {
                         const next = { ...prev };
                         delete next[key];
                         return next;
                    });
               }
          },
          [loadModelsForProvider, providerLookup, registerModelWithProvider]
     );

     const openTestModal = useCallback((provider: MinimalProvider, model: NormalizedModelRow) => {
          setActiveTestConfig({
               providerId: provider.id,
               providerName: provider.name,
               modelKey: model.key,
               modelName: model.displayName,
          });
     }, []);

     const renderProviderTable = (provider: MinimalProvider) => {
          const rows = providerModels[provider.id] ?? [];
          const isLoading = providerLoadingState[provider.id];
          const providerType = provider.type?.charAt(0)?.toUpperCase() + provider.type?.slice(1);

          return (
               <div
                    key={provider.id}
                    className="bg-light-primary dark:bg-dark-primary border-2 border-light-200 dark:border-dark-200 rounded-2xl p-4 md:p-6 space-y-4"
               >
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                         <div>
                              <p className="text-lg font-semibold text-black dark:text-white">{provider.name}</p>
                              <p className="text-xs text-black/60 dark:text-white/60">
                                   {providerType} Provider • {rows.length} {rows.length === 1 ? "model" : "models"}
                              </p>
                         </div>
                         <div className="flex flex-wrap gap-2">
                              <button
                                   type="button"
                                   onClick={() => loadModelsForProvider(provider)}
                                   className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border-2 border-light-200 dark:border-dark-200 text-xs font-medium text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                              >
                                   <RefreshCcw className="w-4 h-4" />
                                   Refresh
                              </button>
                         </div>
                    </div>

                    {isLoading ? (
                         <div className="flex items-center justify-center py-8">
                              <Loader2 className="w-5 h-5 animate-spin text-black/60 dark:text-white/60" />
                              <span className="ml-2 text-sm text-black/60 dark:text-white/60">Loading models...</span>
                         </div>
                    ) : rows.length === 0 ? (
                         <div className="flex flex-col items-center justify-center py-10 text-center">
                              <p className="text-sm font-medium text-black/70 dark:text-white/70">
                                   No models available yet
                              </p>
                              <p className="text-xs text-black/50 dark:text-white/50">
                                   Refresh or update your provider to see models.
                              </p>
                         </div>
                    ) : (
                         <div className="overflow-x-auto">
                              <table className="min-w-full text-left text-xs sm:text-sm">
                                   <thead>
                                        <tr className="text-[10px] sm:text-xs text-black/50 dark:text-white/50 uppercase">
                                             <th className="py-2 pr-4 font-medium">Model</th>
                                             <th className="py-2 pr-4 font-medium">Size</th>
                                             <th className="py-2 pr-4 font-medium">Context</th>
                                             <th className="py-2 pr-4 font-medium">Parameters</th>
                                             <th className="py-2 pr-4 font-medium">Chat</th>
                                             <th className="py-2 pr-4 font-medium">Embeddings</th>
                                             <th className="py-2 font-medium text-right">Action</th>
                                        </tr>
                                   </thead>
                                   <tbody>
                                        {rows.map((model) => {
                                             const downloadKey = `${provider.id}:${model.key}`;
                                             const isDownloading = Boolean(downloadingMap[downloadKey]);
                                             const progress = downloadProgressMap[downloadKey];
                                             return (
                                                  <tr
                                                       key={model.key}
                                                       className="border-t border-light-200/60 dark:border-dark-200/60"
                                                  >
                                                       <td className="py-3 pr-4">
                                                            <div className="flex flex-col gap-0.5">
                                                                 <div className="flex items-center gap-2">
                                                                      <p className="text-sm font-medium text-black dark:text-white">
                                                                           {model.displayName}
                                                                      </p>
                                                                      {model.recommended && (
                                                                           <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F8B692]/20 text-[#F8B692]">
                                                                                Recommended
                                                                           </span>
                                                                      )}
                                                                      {model.installed && (
                                                                           <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                                                                                Installed
                                                                           </span>
                                                                      )}
                                                                 </div>
                                                                 {model.description && (
                                                                      <p className="text-[11px] text-black/60 dark:text-white/60 line-clamp-2">
                                                                           {model.description}
                                                                      </p>
                                                                 )}
                                                            </div>
                                                       </td>
                                                       <td className="py-3 pr-4 text-black/70 dark:text-white/70">
                                                            {model.sizeLabel}
                                                       </td>
                                                       <td className="py-3 pr-4 text-black/70 dark:text-white/70">
                                                            {model.contextWindowLabel}
                                                       </td>
                                                       <td className="py-3 pr-4 text-black/70 dark:text-white/70">
                                                            {model.parameterLabel}
                                                       </td>
                                                       <td className="py-3 pr-4">
                                                            <span
                                                                 className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] ${capabilityBadgeClasses(model.supportsChat)}`}
                                                            >
                                                                 {model.supportsChat ? (
                                                                      <>
                                                                           <Check className="w-3 h-3" />
                                                                           Yes
                                                                      </>
                                                                 ) : (
                                                                      <>No</>
                                                                 )}
                                                            </span>
                                                       </td>
                                                       <td className="py-3 pr-4">
                                                            <span
                                                                 className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] ${capabilityBadgeClasses(model.supportsEmbedding)}`}
                                                            >
                                                                 {model.supportsEmbedding ? (
                                                                      <>
                                                                           <Check className="w-3 h-3" />
                                                                           Yes
                                                                      </>
                                                                 ) : (
                                                                      <>No</>
                                                                 )}
                                                            </span>
                                                       </td>
                                                       <td className="py-3 text-right">
                                                            {model.action === "download" ? (
                                                                 <div className="flex flex-wrap justify-end gap-2">
                                                                      {model.installed ? (
                                                                           <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-light-200 dark:bg-dark-200 text-xs text-black/60 dark:text-white/60">
                                                                                Up to date
                                                                           </span>
                                                                      ) : isDownloading ? (
                                                                           <div className="w-full sm:w-48">
                                                                                <div className="h-2 w-full rounded-full bg-light-200 dark:bg-dark-200 overflow-hidden">
                                                                                     <div
                                                                                          className="h-full rounded-full bg-[#F8B692] transition-all duration-300"
                                                                                          style={{
                                                                                               width: `${progress?.total && progress.total > 0 ? Math.min(progress.progress, 100) : 15}%`,
                                                                                          }}
                                                                                     />
                                                                                </div>
                                                                                <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-black/70 dark:text-white/70">
                                                                                     <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                                     <span>
                                                                                          {progress &&
                                                                                          progress.total > 0
                                                                                               ? `${Math.round(progress.progress)}% (${formatMegabytes(progress.downloaded)} MB / ${formatMegabytes(progress.total)} MB)`
                                                                                               : "Preparing download..."}
                                                                                     </span>
                                                                                </div>
                                                                           </div>
                                                                      ) : (
                                                                           <button
                                                                                type="button"
                                                                                onClick={() =>
                                                                                     handleDownload(provider.id, model)
                                                                                }
                                                                                disabled={isDownloading}
                                                                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F8B692] text-black text-xs font-medium hover:bg-[#e6ad82] active:scale-95 transition disabled:opacity-60"
                                                                           >
                                                                                {isDownloading ? (
                                                                                     <>
                                                                                          <Loader2 className="w-4 h-4 animate-spin" />
                                                                                          Downloading
                                                                                     </>
                                                                                ) : (
                                                                                     <>
                                                                                          <Download className="w-4 h-4" />
                                                                                          Download
                                                                                     </>
                                                                                )}
                                                                           </button>
                                                                      )}

                                                                      {model.supportsEmbedding && (
                                                                           <button
                                                                                type="button"
                                                                                onClick={() =>
                                                                                     openTestModal(provider, model)
                                                                                }
                                                                                disabled={!model.installed}
                                                                                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F8B692] text-black text-xs font-medium hover:bg-[#e6ad82] active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                                                           >
                                                                                Test Embedding
                                                                           </button>
                                                                      )}
                                                                 </div>
                                                            ) : (
                                                                 <button
                                                                      type="button"
                                                                      disabled
                                                                      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-light-200 dark:border-dark-200 text-xs text-black/60 dark:text-white/60"
                                                                 >
                                                                      Remote Access
                                                                 </button>
                                                            )}
                                                       </td>
                                                  </tr>
                                             );
                                        })}
                                   </tbody>
                              </table>
                         </div>
                    )}
               </div>
          );
     };

     return (
          <>
               <div className="h-full flex flex-col">
                    <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-4">
                         <div>
                              <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                                   Models & Providers
                              </h1>
                              <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                                   Discover & download available models across every connected provider.
                              </p>
                         </div>
                         <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-black/70 dark:text-white/70">
                              <div className="px-4 py-2 rounded-xl border-2 border-light-200 dark:border-dark-200 bg-light-primary/70 dark:bg-dark-primary/70">
                                   {providers.length} {providers.length === 1 ? "Provider" : "Providers"}
                              </div>
                              <div className="px-4 py-2 rounded-xl border-2 border-light-200 dark:border-dark-200 bg-light-primary/70 dark:bg-dark-primary/70">
                                   {totalModels} {totalModels === 1 ? "Model" : "Models"}
                              </div>
                              <button
                                   type="button"
                                   onClick={() => void fetchProviders()}
                                   className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black font-medium text-sm hover:bg-[#e6ad82] active:scale-95 transition"
                              >
                                   <RefreshCcw className="w-4 h-4" />
                                   Refresh All
                              </button>
                         </div>
                    </div>

                    <div className="flex-1 overflow-y-auto px-6 pb-6">
                         {isLoadingProviders ? (
                              <div className="flex flex-col items-center justify-center py-12">
                                   <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                                   <p className="text-sm text-black/60 dark:text-white/60">Loading providers...</p>
                              </div>
                         ) : errorMessage ? (
                              <div className="flex flex-col items-center justify-center py-12 text-center">
                                   <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                        {errorMessage}
                                   </p>
                                   <p className="text-sm text-black/50 dark:text-white/50">
                                        Please refresh to try again.
                                   </p>
                              </div>
                         ) : providers.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-12 text-center">
                                   <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                        No providers configured yet
                                   </p>
                                   <p className="text-sm text-black/50 dark:text-white/50">
                                        Add a provider from the setup flow to begin managing models.
                                   </p>
                              </div>
                         ) : (
                              <div className="relative max-w-6xl mx-auto space-y-6 pt-10">
                                   <Image
                                        src={GoFetchDog}
                                        alt="GoFetch dog mascot"
                                        width={80}
                                        height={80}
                                        className="absolute top-0 -left z pointer-events-none"
                                   />
                                   {providers.map((provider) => renderProviderTable(provider))}
                              </div>
                         )}
                    </div>
               </div>

               <TestEmbeddingModal config={activeTestConfig} onClose={() => setActiveTestConfig(null)} />
          </>
     );
};

type TestEmbeddingModalProps = {
     config: TestModalConfig | null;
     onClose: () => void;
};

const TestEmbeddingModal = ({ config, onClose }: TestEmbeddingModalProps) => {
     const [activeTab, setActiveTab] = useState<TestTabId>("text");
     const [textA, setTextA] = useState(DEFAULT_TEXT_SAMPLE_A);
     const [textB, setTextB] = useState(DEFAULT_TEXT_SAMPLE_B);
     const [isSending, setIsSending] = useState(false);
     const [similarity, setSimilarity] = useState<number | null>(null);
     const [error, setError] = useState<string | null>(null);

     useEffect(() => {
          if (!config) {
               return;
          }
          setActiveTab("text");
          setTextA(DEFAULT_TEXT_SAMPLE_A);
          setTextB(DEFAULT_TEXT_SAMPLE_B);
          setSimilarity(null);
          setError(null);
     }, [config]);

     if (!config) {
          return null;
     }

     const handleSend = async () => {
          if (activeTab === "code") {
               setError("Code embeddings are coming soon.");
               return;
          }

          if (!textA.trim() || !textB.trim()) {
               setError("Both prompts are required.");
               return;
          }

          setIsSending(true);
          setError(null);
          setSimilarity(null);

          try {
               const res = await fetch("/api/test-embedding", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                         providerId: config.providerId,
                         modelKey: config.modelKey,
                         inputs: [textA.trim(), textB.trim()],
                    }),
               });

               const data = await res.json().catch(() => ({}));

               if (!res.ok) {
                    throw new Error(data?.error || "Failed to test embedding");
               }

               setSimilarity(typeof data?.similarity === "number" ? data.similarity : null);
          } catch (err) {
               const message = err instanceof Error ? err.message : "Failed to test embedding";
               setError(message);
               toast.error(message);
          } finally {
               setIsSending(false);
          }
     };

     const similarityLabel = similarity != null ? similarity.toFixed(3) : null;

     return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
               <div className="w-full max-w-2xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl shadow-xl p-6 space-y-6">
                    <div className="flex items-start justify-between gap-4">
                         <div>
                              <p className="text-lg font-semibold text-black dark:text-white">Test Embedding</p>
                              <p className="text-xs text-black/60 dark:text-white/60">
                                   {config.providerName} • {config.modelName}
                              </p>
                         </div>
                         <button
                              type="button"
                              onClick={onClose}
                              className="p-1 rounded-full text-black/60 dark:text-white/60 hover:bg-light-200/80 dark:hover:bg-dark-200/80"
                         >
                              <X className="w-4 h-4" />
                         </button>
                    </div>

                    <div className="flex gap-2">
                         {TEST_TABS.map((tab) => (
                              <button
                                   key={tab.id}
                                   type="button"
                                   onClick={() => setActiveTab(tab.id)}
                                   className={cn(
                                        "flex-1 rounded-lg border px-4 py-2 text-sm font-medium text-black",
                                        activeTab === tab.id
                                             ? "border-[#F8B692] bg-[#F8B692]/20"
                                             : "border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary"
                                   )}
                              >
                                   {tab.label}
                              </button>
                         ))}
                    </div>

                    {activeTab === "text" ? (
                         <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                   <label className="text-xs font-medium text-black/70 dark:text-white/70">
                                        Prompt A
                                   </label>
                                   <textarea
                                        value={textA}
                                        onChange={(event) => setTextA(event.target.value)}
                                        className="mt-1 h-32 w-full rounded-xl border-2 border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary px-3 py-2 text-sm text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-[#F8B692]"
                                   />
                              </div>
                              <div>
                                   <label className="text-xs font-medium text-black/70 dark:text-white/70">
                                        Prompt B
                                   </label>
                                   <textarea
                                        value={textB}
                                        onChange={(event) => setTextB(event.target.value)}
                                        className="mt-1 h-32 w-full rounded-xl border-2 border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary px-3 py-2 text-sm text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-[#F8B692]"
                                   />
                              </div>
                         </div>
                    ) : (
                         <div className="flex items-center justify-center rounded-xl border border-dashed border-light-200 dark:border-dark-200 bg-light-secondary/50 dark:bg-dark-secondary/50 py-20 text-sm text-black/50 dark:text-white/50">
                              Code embeddings preview coming soon.
                         </div>
                    )}

                    {error && <p className="text-xs text-red-500">{error}</p>}
                    {similarityLabel && (
                         <div className="rounded-xl border border-light-200 dark:border-dark-200 bg-light-secondary/60 dark:bg-dark-secondary/60 px-4 py-3 text-sm text-black dark:text-white">
                              Cosine similarity: <span className="font-semibold">{similarityLabel}</span>
                         </div>
                    )}

                    <div className="flex justify-end gap-3 pt-2">
                         <button
                              type="button"
                              onClick={onClose}
                              className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                              disabled={isSending}
                         >
                              Close
                         </button>
                         <button
                              type="button"
                              onClick={handleSend}
                              disabled={isSending || activeTab === "code"}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition disabled:opacity-60"
                         >
                              {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send"}
                         </button>
                    </div>
               </div>
          </div>
     );
};

export default ModelsPage;
