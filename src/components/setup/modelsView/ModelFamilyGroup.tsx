"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Download, Loader2, Star } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface ModelRow {
     key: string;
     displayName: string;
     description?: string;
     sizeLabel: string;
     contextWindowLabel: string;
     parameterLabel: string;
     supportsChat: boolean;
     supportsEmbedding: boolean;
     supportsOCR: boolean;
     action: "download" | "remote";
     recommended?: boolean;
     installed?: boolean;
}

type DownloadProgressState = {
     progress: number;
     downloaded: number;
     total: number;
};

interface ModelFamilyGroupProps {
     family: string;
     models: ModelRow[];
     providerId: string;
     onDownload: (model: ModelRow) => void;
     downloadingMap: Record<string, boolean>;
     downloadProgressMap: Record<string, DownloadProgressState>;
     onTest: (model: ModelRow) => void;
}

export const inferFamilyFromName = (name: string): string => {
     const lower = name.toLowerCase();
     if (lower.includes("gpt-os") || lower.includes("gpt-oss")) return "GPT-OSS";
     if (lower.includes("llama")) return "Llama";
     if (lower.includes("deepseek") || lower.includes("r1")) return "DeepSeek";
     if (lower.includes("qwen")) return "Qwen";
     if (lower.includes("gemma")) return "Gemma";
     if (lower.includes("mistral")) return "Mistral";
     if (lower.includes("phi")) return "Phi";
     if (lower.includes("granite")) return "Granite";
     return "Other";
};

const FAMILY_META: Record<string, { color: string; initial: string; icon?: string }> = {
     "GPT-OSS":    { color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", initial: "O", icon: "/assets/openai.svg" },
     Llama:        { color: "bg-purple-500/10 text-purple-600 dark:text-purple-400",  initial: "L", icon: "/assets/meta-color.svg" },
     DeepSeek:     { color: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",  initial: "D", icon: "/assets/deepseek-color.svg" },
     Qwen:         { color: "bg-sky-500/10 text-sky-600 dark:text-sky-400",           initial: "Q", icon: "/assets/qwen-color.svg"  },
     Gemma:        { color: "bg-blue-500/10 text-blue-600 dark:text-blue-400",        initial: "G", icon: "/assets/gemma-color.svg"  },
     Mistral:      { color: "bg-orange-500/10 text-orange-600 dark:text-orange-400",  initial: "M", icon: "/assets/mistral-color.svg"  },
     Phi:          { color: "bg-teal-500/10 text-teal-600 dark:text-teal-400",        initial: "Φ", icon: "/assets/microsoft-color.svg"  },
     Granite:      { color: "bg-stone-500/10 text-stone-600 dark:text-stone-400",     initial: "Gr", icon: "/assets/ibm.svg" },
};

const ModelFamilyGroup = ({
     family,
     models,
     providerId,
     onDownload,
     downloadingMap,
     downloadProgressMap,
     onTest,
}: ModelFamilyGroupProps) => {
     const meta = FAMILY_META[family] ?? FAMILY_META["Other"];
     const installedCount = models.filter((m) => m.installed).length;
     const hasRecommended = models.some((m) => m.recommended);
     const [isOpen, setIsOpen] = useState(hasRecommended || installedCount > 0);

     return (
          <div className="bg-light-primary dark:bg-dark-primary border-2 border-light-200 dark:border-dark-200 rounded-2xl overflow-hidden">
               {/* Card Header */}
               <button
                    type="button"
                    onClick={() => setIsOpen((v) => !v)}
                    className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-light-200/40 dark:hover:bg-dark-200/40 transition-colors"
               >
                    <div className="flex items-center gap-3">
                         <div
                              className={cn(
                                   "w-9 h-9 rounded-xl flex items-center justify-center font-black text-xs shrink-0",
                                   meta.icon ? "bg-white border border-light-200 dark:border-dark-200 shadow-sm" : meta.color
                              )}
                         >
                              {meta.icon ? (
                                   <div className="relative w-6 h-6">
                                        <Image
                                             src={meta.icon}
                                             alt={family}
                                             fill
                                             className="object-contain"
                                        />
                                   </div>
                              ) : (
                                   meta.initial
                              )}
                         </div>
                         <div>
                              <div className="flex items-center gap-2">
                                   <span className="font-bold text-base text-black dark:text-white">{family}</span>
                                   {hasRecommended && (
                                        <span className="flex items-center gap-1 text-[10px] font-bold text-[#F8B692] bg-[#F8B692]/10 px-2 py-0.5 rounded-full uppercase">
                                             <Star size={9} className="fill-current" /> Recommended
                                        </span>
                                   )}
                              </div>
                              <p className="text-xs text-black/50 dark:text-white/50">
                                   {models.length} {models.length === 1 ? "model" : "models"}
                                   {installedCount > 0 && ` · ${installedCount} installed`}
                              </p>
                         </div>
                    </div>
                    {isOpen ? (
                         <ChevronDown size={16} className="text-black/40 dark:text-white/40 shrink-0" />
                    ) : (
                         <ChevronRight size={16} className="text-black/40 dark:text-white/40 shrink-0" />
                    )}
               </button>

               {/* Model Rows */}
               {isOpen && (
                    <div className="border-t border-light-200 dark:border-dark-200 divide-y divide-light-200/60 dark:divide-dark-200/60">
                         {models.map((model) => {
                              const rowKey = `${providerId}:${model.key}`;
                              const isDownloading = Boolean(downloadingMap[rowKey]);
                              const progress = downloadProgressMap[rowKey];

                              return (
                                   <div
                                        key={model.key}
                                        className="flex flex-col md:flex-row md:items-center gap-3 px-5 py-4"
                                   >
                                        {/* Model info */}
                                        <div className="flex-1 min-w-0">
                                             <div className="flex items-center gap-2 flex-wrap mb-1">
                                                  <span className="font-semibold text-sm text-black dark:text-white truncate">
                                                       {model.displayName}
                                                  </span>
                                                  {model.recommended && (
                                                       <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#F8B692]/20 text-[#F8B692] shrink-0">
                                                            Recommended
                                                       </span>
                                                  )}
                                                  {model.installed && (
                                                       <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200 shrink-0">
                                                            Installed
                                                       </span>
                                                  )}
                                             </div>
                                             {model.description && (
                                                  <p className="text-[11px] text-black/60 dark:text-white/60 line-clamp-2 mb-2">
                                                       {model.description}
                                                  </p>
                                             )}
                                             <div className="flex flex-wrap items-center gap-1.5">
                                                  {model.parameterLabel && model.parameterLabel !== "—" && (
                                                       <span className="text-[10px] font-medium text-black/50 dark:text-white/40 bg-light-secondary dark:bg-dark-secondary px-2 py-0.5 rounded border border-light-200 dark:border-dark-200">
                                                            {model.parameterLabel}
                                                       </span>
                                                  )}
                                                  {model.sizeLabel && model.sizeLabel !== "—" && (
                                                       <span className="text-[10px] text-black/40 dark:text-white/30 bg-light-secondary dark:bg-dark-secondary px-2 py-0.5 rounded border border-light-200 dark:border-dark-200">
                                                            {model.sizeLabel}
                                                       </span>
                                                  )}
                                                  {model.contextWindowLabel && model.contextWindowLabel !== "—" && (
                                                       <span className="text-[10px] text-black/40 dark:text-white/30 bg-light-secondary dark:bg-dark-secondary px-2 py-0.5 rounded border border-light-200 dark:border-dark-200">
                                                            ctx {model.contextWindowLabel}
                                                       </span>
                                                  )}
                                                  {model.supportsChat && (
                                                       <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 uppercase">
                                                            Chat
                                                       </span>
                                                  )}
                                                  {model.supportsEmbedding && (
                                                       <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 uppercase">
                                                            Embed
                                                       </span>
                                                  )}
                                                  {model.supportsOCR && (
                                                       <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 uppercase">
                                                            OCR
                                                       </span>
                                                  )}
                                             </div>
                                        </div>

                                        {/* Action */}
                                        <div className="shrink-0 flex flex-wrap items-center gap-2">
                                             {isDownloading ? (
                                                  <div className="flex flex-col items-end gap-1">
                                                       <div className="flex items-center gap-2 text-[#F8B692] font-medium text-sm">
                                                            <Loader2 size={15} className="animate-spin" />
                                                            {progress && progress.total > 0
                                                                 ? `${Math.round(progress.progress)}%`
                                                                 : "Downloading..."}
                                                       </div>
                                                       {progress && progress.total > 0 && (
                                                            <div className="w-24 bg-light-200 dark:bg-dark-200 rounded-full h-1.5 overflow-hidden">
                                                                 <div
                                                                      className="h-full bg-[#F8B692] rounded-full transition-all duration-300"
                                                                      style={{ width: `${progress.progress}%` }}
                                                                 />
                                                            </div>
                                                       )}
                                                  </div>
                                             ) : model.action === "download" ? (
                                                  <>
                                                       {!model.installed && (
                                                            <button
                                                                 type="button"
                                                                 onClick={() => onDownload(model)}
                                                                 className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F8B692] text-black text-xs font-medium hover:bg-[#e6ad82] active:scale-95 transition"
                                                            >
                                                                 <Download size={14} />
                                                                 Download
                                                            </button>
                                                       )}
                                                       {model.supportsEmbedding && (
                                                            <button
                                                                 type="button"
                                                                 onClick={() => onTest(model)}
                                                                 disabled={!model.installed}
                                                                 className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F8B692] text-black text-xs font-medium hover:bg-[#e6ad82] active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                                            >
                                                                 Test Embedding
                                                            </button>
                                                       )}
                                                  </>
                                             ) : (
                                                  <button
                                                       type="button"
                                                       disabled
                                                       className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-light-200 dark:border-dark-200 text-xs text-black/60 dark:text-white/60"
                                                  >
                                                       Remote Access
                                                  </button>
                                             )}
                                        </div>
                                   </div>
                              );
                         })}
                    </div>
               )}
          </div>
     );
};

export default ModelFamilyGroup;
