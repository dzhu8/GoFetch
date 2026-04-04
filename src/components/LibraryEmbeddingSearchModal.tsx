"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import {
     AlertCircle,
     ExternalLink,
     FileText,
     FolderOpen,
     Globe,
     Loader2,
     Search,
     X,
     ChevronDown,
     Check,
} from "lucide-react";
import type { SearchResult, SearchScope, LibrarySearchResponse } from "@/lib/actions/library";
import type { ModelPreference } from "@/lib/models/modelPreference";
import { getLibraryFolders, searchLibrary } from "@/lib/actions/library";
import { getConfig } from "@/lib/actions/config";

// ── Score badge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score }: { score: number }) {
     const pct = Math.round(score * 100);
     const colour =
          pct >= 60
               ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20"
               : pct >= 30
                 ? "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20"
                 : "text-black/40 dark:text-white/40 bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10";
     return (
          <span
               className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono ${colour}`}
               title="Cosine similarity"
          >
               {pct}%
          </span>
     );
}

// ── Folder pill ───────────────────────────────────────────────────────────────

export interface FolderPill {
     id: number | "all";
     name: string;
}

interface FolderPillBadgeProps {
     pill: FolderPill;
     onRemove?: () => void;
}

export function FolderPillBadge({ pill, onRemove }: FolderPillBadgeProps) {
     return (
          <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium bg-[#F8B692]/15 text-[#F8B692] border border-[#F8B692]/25 select-none">
               <FolderOpen className="w-3 h-3 shrink-0" />
               <span className="max-w-[120px] truncate">{pill.name}</span>
               {onRemove && (
                    <button
                         type="button"
                         onClick={(e) => { e.stopPropagation(); onRemove(); }}
                         className="ml-0.5 p-0.5 rounded-full hover:bg-[#F8B692]/30 transition-colors"
                         aria-label={`Remove ${pill.name}`}
                    >
                         <X className="w-2.5 h-2.5" />
                    </button>
               )}
          </span>
     );
}

// ── Result row ────────────────────────────────────────────────────────────────

function ResultRow({ result }: { result: SearchResult }) {
     if (result.type === "chunk") {
          return (
               <div className="px-4 py-3 border-b border-light-200/60 dark:border-dark-200/60 hover:bg-light-secondary/40 dark:hover:bg-dark-secondary/40 transition-colors">
                    <div className="flex items-start gap-3">
                         <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-blue-500/10">
                              <FileText className="w-3.5 h-3.5 text-blue-500" />
                         </div>
                         <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                   <span className="text-[10px] px-1.5 py-0.5 rounded border bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400 font-semibold uppercase tracking-wide">
                                        {result.sectionType.replace(/_/g, " ")}
                                   </span>
                                   <ScoreBadge score={result.score} />
                              </div>
                              <p className="text-sm font-semibold text-black dark:text-white leading-tight mb-1 truncate">
                                   {result.paperTitle || result.paperFileName}
                              </p>
                              {result.paperDoi && (
                                   <p className="text-[10px] font-mono text-black/40 dark:text-white/40 truncate mb-1">
                                        {result.paperDoi}
                                   </p>
                              )}
                              <p className="text-xs text-black/60 dark:text-white/60 line-clamp-3 leading-relaxed">
                                   {result.content}
                              </p>
                         </div>
                    </div>
               </div>
          );
     }

     // abstract result
     const href = result.s2Url ?? (result.doi ? `https://doi.org/${encodeURIComponent(result.doi)}` : null);
     return (
          <div className="px-4 py-3 border-b border-light-200/60 dark:border-dark-200/60 hover:bg-light-secondary/40 dark:hover:bg-dark-secondary/40 transition-colors">
               <div className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5 p-1.5 rounded-lg bg-[#F8B692]/10">
                         <Globe className="w-3.5 h-3.5 text-[#F8B692]" />
                    </div>
                    <div className="min-w-0 flex-1">
                         <div className="flex items-center gap-2 flex-wrap mb-1">
                              <span className="text-[10px] px-1.5 py-0.5 rounded border bg-[#F8B692]/10 border-[#F8B692]/20 text-[#F8B692] font-semibold uppercase tracking-wide">
                                   Abstract · depth {result.minDepth}
                              </span>
                              <ScoreBadge score={result.score} />
                         </div>
                         <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-semibold text-black dark:text-white leading-tight mb-1">
                                   {result.title ?? "(untitled)"}
                              </p>
                              {href && (
                                   <a
                                        href={href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="shrink-0 p-1 text-black/30 dark:text-white/30 hover:text-[#F8B692] transition-colors"
                                        aria-label="Open paper"
                                   >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                   </a>
                              )}
                         </div>
                         {(result.authors || result.year) && (
                              <p className="text-[10px] text-black/50 dark:text-white/50 mb-1">
                                   {[result.authors, result.year?.toString(), result.venue].filter(Boolean).join(" · ")}
                              </p>
                         )}
                         <p className="text-xs text-black/60 dark:text-white/60 line-clamp-3 leading-relaxed">
                              {result.abstract}
                         </p>
                    </div>
               </div>
          </div>
     );
}

// ── Main modal ────────────────────────────────────────────────────────────────

interface LibrarySearchModalProps {
     currentFolderId: number;
     currentFolderName: string;
     onClose: () => void;
}

interface FolderOption {
     id: number;
     name: string;
}

interface ModelOption {
     providerId: string;
     modelKey: string;
     label: string;
}

const SCOPE_LABELS: Record<SearchScope, string> = {
     papers: "Only Papers",
     web_abstracts: "Abstracts from Web",
     both: "Papers and Abstracts",
};

export default function LibrarySearchModal({ currentFolderId, currentFolderName, onClose }: LibrarySearchModalProps) {
     const [query, setQuery] = useState("");
     const [searchScope, setSearchScope] = useState<SearchScope>("both");
     const [selectedModel, setSelectedModel] = useState<ModelPreference | null>(null);
     const [selectedFolders, setSelectedFolders] = useState<FolderPill[]>([{ id: "all", name: "Whole Library" }]);

     const [folderOptions, setFolderOptions] = useState<FolderOption[]>([]);
     const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
     const [defaultModelKey, setDefaultModelKey] = useState<string>("");

     const [isSearching, setIsSearching] = useState(false);
     const [results, setResults] = useState<SearchResult[] | null>(null);
     const [error, setError] = useState<string | null>(null);
     const [embeddingInfo, setEmbeddingInfo] = useState<{ model: string; total: number; onTheFly: number } | null>(null);

     const [modelOpen, setModelOpen] = useState(false);
     const [folderPickerOpen, setFolderPickerOpen] = useState(false);

     const inputRef = useRef<HTMLInputElement>(null);

     // Close dropdowns on outside click
     const modelRef = useRef<HTMLDivElement>(null);
     const folderRef = useRef<HTMLDivElement>(null);

     useEffect(() => {
          const handler = (e: MouseEvent) => {
               if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelOpen(false);
               if (folderRef.current && !folderRef.current.contains(e.target as Node)) setFolderPickerOpen(false);
          };
          document.addEventListener("mousedown", handler);
          return () => document.removeEventListener("mousedown", handler);
     }, []);

     // Focus input on mount
     useEffect(() => { inputRef.current?.focus(); }, []);

     // Load folders and models
     useEffect(() => {
          let cancelled = false;
          (async () => {
               try {
                    const [foldersData, configData] = await Promise.all([
                         getLibraryFolders(),
                         getConfig(),
                    ]);
                    if (cancelled) return;

                    if (!("error" in foldersData)) {
                         const folders: FolderOption[] = (foldersData.folders ?? []).map((f: { id: number; name: string }) => ({
                              id: f.id,
                              name: f.name,
                         }));
                         setFolderOptions(folders);
                    }

                    if (!("error" in configData)) {
                         const providers: Array<{ id: string; name: string; embeddingModels: Array<{ key: string; name: string }> }> =
                              configData.values?.modelProviders ?? [];
                         const opts: ModelOption[] = [];
                         for (const p of providers) {
                              for (const m of p.embeddingModels ?? []) {
                                   opts.push({ providerId: p.id, modelKey: m.key, label: `${p.name} / ${m.name ?? m.key}` });
                              }
                         }
                         setModelOptions(opts);

                         const pref = configData.values?.preferences?.defaultEmbeddingModel as ModelPreference | undefined;
                         if (pref) {
                              setSelectedModel(pref);
                              setDefaultModelKey(`${pref.providerId}/${pref.modelKey}`);
                         }
                    }
               } catch { /* ignore */ }
          })();
          return () => { cancelled = true; };
     }, []);

     const activeModelLabel = useCallback(() => {
          if (!selectedModel) return "Default Model";
          const opt = modelOptions.find((o) => o.providerId === selectedModel.providerId && o.modelKey === selectedModel.modelKey);
          return opt?.label ?? `${selectedModel.modelKey}`;
     }, [selectedModel, modelOptions]);

     const isFolderSelected = (id: number | "all") => selectedFolders.some((f) => f.id === id);

     const toggleFolder = (folder: FolderOption) => {
          const allIdx = selectedFolders.findIndex((f) => f.id === "all");
          if (allIdx !== -1) {
               // Replace "whole library" with specific folder
               setSelectedFolders([{ id: folder.id, name: folder.name }]);
               return;
          }
          if (isFolderSelected(folder.id)) {
               const next = selectedFolders.filter((f) => f.id !== folder.id);
               setSelectedFolders(next.length > 0 ? next : [{ id: "all", name: "Whole Library" }]);
          } else {
               setSelectedFolders((prev) => [...prev, { id: folder.id, name: folder.name }]);
          }
     };

     const addWholeLibrary = () => {
          setSelectedFolders([{ id: "all", name: "Whole Library" }]);
     };

     const removePill = (id: number | "all") => {
          const next = selectedFolders.filter((f) => f.id !== id);
          setSelectedFolders(next.length > 0 ? next : [{ id: "all", name: "Whole Library" }]);
     };

     const handleSearch = useCallback(async () => {
          const q = query.trim();
          if (!q) return;
          setIsSearching(true);
          setError(null);
          setResults(null);
          setEmbeddingInfo(null);
          try {
               const folderIds = selectedFolders.every((f) => f.id === "all")
                    ? null
                    : (selectedFolders.map((f) => f.id).filter((id) => id !== "all") as number[]);

               const data = await searchLibrary(
                    q,
                    folderIds,
                    searchScope,
                    selectedModel ?? undefined,
               );
               if ("error" in data) {
                    throw new Error(data.error ?? "Search failed");
               }
               const typedData = data as LibrarySearchResponse;
               setResults(typedData.results);
               setEmbeddingInfo({ model: typedData.embeddingModel, total: typedData.totalCandidates, onTheFly: typedData.embeddedOnTheFly });
          } catch (err) {
               setError(err instanceof Error ? err.message : "Search failed");
          } finally {
               setIsSearching(false);
          }
     }, [query, selectedFolders, searchScope, selectedModel]);

     const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") handleSearch();
          if (e.key === "Escape") onClose();
     };

     return (
          <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
               <div className="w-full max-w-3xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-[90vh]">
                    {/* Header */}
                    <div className="flex items-center gap-3 px-5 py-3 border-b border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary">
                         <div className="p-1.5 rounded-lg bg-[#F8B692]/10 shrink-0">
                              <Search className="w-4 h-4 text-[#F8B692]" />
                         </div>
                         <span className="text-sm font-semibold text-black dark:text-white flex-1">Library Quick Search</span>
                         <button
                              type="button"
                              onClick={onClose}
                              className="p-1.5 rounded-lg text-black/50 dark:text-white/50 hover:bg-light-200/60 dark:hover:bg-dark-200/60 transition-colors"
                              aria-label="Close search"
                         >
                              <X className="w-4 h-4" />
                         </button>
                    </div>

                    {/* Search bar */}
                    <div className="px-6 pt-5 pb-3">
                         <div className="flex items-center gap-3 bg-light-secondary dark:bg-dark-secondary rounded-xl border border-light-200 dark:border-dark-200 px-4 py-3 focus-within:border-[#F8B692]/50 transition-colors">
                              <Search className="w-4 h-4 text-black/40 dark:text-white/40 shrink-0" />
                              <input
                                   ref={inputRef}
                                   type="text"
                                   value={query}
                                   onChange={(e) => setQuery(e.target.value)}
                                   onKeyDown={handleKeyDown}
                                   placeholder="Search your library by meaning…"
                                   className="flex-1 bg-transparent text-sm text-black dark:text-white placeholder-black/40 dark:placeholder-white/40 outline-none min-w-0"
                              />
                              <button
                                   type="button"
                                   onClick={handleSearch}
                                   disabled={isSearching || !query.trim()}
                                   className="shrink-0 inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-[#F8B692] text-white text-xs font-medium hover:bg-[#F8B692]/80 active:scale-95 transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                   {isSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                                   Search
                              </button>
                         </div>
                    </div>

                    {/* Controls: scope toggles */}
                    <div className="px-6 pb-2 flex items-center gap-1.5">
                         <span className="text-[10px] uppercase tracking-wider text-black/30 dark:text-white/30 font-bold mr-1 shrink-0">Search in</span>
                         {(Object.entries(SCOPE_LABELS) as [SearchScope, string][]).map(([val, label]) => (
                              <button
                                   key={val}
                                   type="button"
                                   onClick={() => setSearchScope(val)}
                                   className={`px-3 py-1 rounded-lg text-xs font-medium transition-all duration-150 border ${
                                        searchScope === val
                                             ? "bg-[#F8B692]/15 text-[#F8B692] border-[#F8B692]/30"
                                             : "bg-transparent text-black/50 dark:text-white/50 border-light-200 dark:border-dark-200 hover:border-[#F8B692]/30 hover:text-black/70 dark:hover:text-white/70"
                                   }`}
                              >
                                   {label}
                              </button>
                         ))}
                    </div>

                    {/* Controls: model picker + folder pills */}
                    <div className="px-6 pb-4 flex items-center gap-3 flex-wrap">
                         {/* Model dropdown */}
                         <div className="relative" ref={modelRef}>
                              <button
                                   type="button"
                                   onClick={() => { setModelOpen((v) => !v); setFolderPickerOpen(false); }}
                                   className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 text-black/60 dark:text-white/60 hover:border-[#F8B692]/40 transition-colors max-w-[220px]"
                              >
                                   <span className="truncate">{activeModelLabel()}</span>
                                   <ChevronDown className={`w-3 h-3 opacity-50 shrink-0 transition-transform ${modelOpen ? "rotate-180" : ""}`} />
                              </button>
                              {modelOpen && (
                                   <div className="absolute top-full left-0 mt-1 w-64 rounded-xl bg-white dark:bg-[#1a1a1a] border border-light-200 dark:border-dark-200 shadow-xl z-50 overflow-hidden max-h-48 overflow-y-auto">
                                        {modelOptions.length === 0 ? (
                                             <div className="px-3 py-2 text-xs text-black/40 dark:text-white/40">No embedding models configured</div>
                                        ) : modelOptions.map((opt) => {
                                             const key = `${opt.providerId}/${opt.modelKey}`;
                                             const isDefault = key === defaultModelKey;
                                             const isActive =
                                                  selectedModel
                                                       ? selectedModel.providerId === opt.providerId && selectedModel.modelKey === opt.modelKey
                                                       : isDefault;
                                             return (
                                                  <button
                                                       key={key}
                                                       type="button"
                                                       onClick={() => {
                                                            setSelectedModel({ providerId: opt.providerId, modelKey: opt.modelKey });
                                                            setModelOpen(false);
                                                       }}
                                                       className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-[#F8B692]/5 transition-colors ${isActive ? "text-[#F8B692] font-semibold bg-[#F8B692]/5" : "text-black/70 dark:text-white/70"}`}
                                                  >
                                                       <span className="truncate">{opt.label}{isDefault ? " (default)" : ""}</span>
                                                       {isActive && <Check className="w-3 h-3 shrink-0 ml-2" />}
                                                  </button>
                                             );
                                        })}
                                   </div>
                              )}
                         </div>

                         {/* Divider */}
                         <div className="w-px h-4 bg-light-200 dark:bg-dark-200 shrink-0" />

                         {/* Folder pills */}
                         <div className="relative flex-1 min-w-0" ref={folderRef}>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                   {selectedFolders.map((pill) => (
                                        <FolderPillBadge
                                             key={pill.id}
                                             pill={pill}
                                             onRemove={() => removePill(pill.id)}
                                        />
                                   ))}
                                   <button
                                        type="button"
                                        onClick={() => { setFolderPickerOpen((v) => !v); setModelOpen(false); }}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border border-dashed border-black/20 dark:border-white/20 text-black/40 dark:text-white/40 hover:border-[#F8B692]/50 hover:text-[#F8B692] transition-colors"
                                        aria-label="Add folder filter"
                                   >
                                        <FolderOpen className="w-3 h-3" />
                                        <span>+</span>
                                   </button>
                              </div>
                              {folderPickerOpen && (
                                   <div className="absolute top-full left-0 mt-1 w-56 rounded-xl bg-white dark:bg-[#1a1a1a] border border-light-200 dark:border-dark-200 shadow-xl z-50 overflow-hidden max-h-48 overflow-y-auto">
                                        <button
                                             type="button"
                                             onClick={() => { addWholeLibrary(); setFolderPickerOpen(false); }}
                                             className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-[#F8B692]/5 transition-colors ${isFolderSelected("all") ? "text-[#F8B692] font-semibold bg-[#F8B692]/5" : "text-black/70 dark:text-white/70"}`}
                                        >
                                             <span className="flex items-center gap-1.5">
                                                  <FolderOpen className="w-3 h-3" />
                                                  Whole Library
                                             </span>
                                             {isFolderSelected("all") && <Check className="w-3 h-3" />}
                                        </button>
                                        {folderOptions.length > 0 && (
                                             <div className="border-t border-light-200 dark:border-dark-200" />
                                        )}
                                        {folderOptions.map((folder) => (
                                             <button
                                                  key={folder.id}
                                                  type="button"
                                                  onClick={() => { toggleFolder(folder); setFolderPickerOpen(false); }}
                                                  className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-[#F8B692]/5 transition-colors ${isFolderSelected(folder.id) ? "text-[#F8B692] font-semibold bg-[#F8B692]/5" : "text-black/70 dark:text-white/70"}`}
                                             >
                                                  <span className="flex items-center gap-1.5 min-w-0">
                                                       <FolderOpen className="w-3 h-3 shrink-0" />
                                                       <span className="truncate">{folder.name}</span>
                                                  </span>
                                                  {isFolderSelected(folder.id) && <Check className="w-3 h-3 shrink-0 ml-2" />}
                                             </button>
                                        ))}
                                   </div>
                              )}
                         </div>
                    </div>

                    {/* Results area */}
                    <div className="flex-1 overflow-y-auto min-h-0 border-t border-light-200 dark:border-dark-200">
                         {isSearching && (
                              <div className="flex flex-col items-center justify-center py-12 gap-2">
                                   <Loader2 className="w-7 h-7 animate-spin text-[#F8B692]" />
                                   <p className="text-sm text-black/50 dark:text-white/50">Searching…</p>
                              </div>
                         )}

                         {error && (
                              <div className="mx-5 my-3 flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs">
                                   <AlertCircle className="w-4 h-4 shrink-0" />
                                   <span>{error}</span>
                              </div>
                         )}

                         {results !== null && !isSearching && (
                              <>
                                   {/* Meta info bar */}
                                   {embeddingInfo && (
                                        <div className="px-5 py-2 flex items-center gap-3 flex-wrap bg-light-secondary/40 dark:bg-dark-secondary/40">
                                             <span className="text-[10px] text-black/40 dark:text-white/40">
                                                  {results.length} result{results.length !== 1 ? "s" : ""} from {embeddingInfo.total} candidates
                                             </span>
                                             {embeddingInfo.onTheFly > 0 && (
                                                  <span className="text-[10px] text-black/30 dark:text-white/30">
                                                       ({embeddingInfo.onTheFly} embedded on the fly)
                                                  </span>
                                             )}
                                             <span className="text-[10px] font-mono text-black/30 dark:text-white/30 ml-auto">
                                                  {embeddingInfo.model}
                                             </span>
                                        </div>
                                   )}

                                   {results.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-center px-4">
                                             <Search className="w-8 h-8 text-black/15 dark:text-white/15" />
                                             <p className="text-sm text-black/50 dark:text-white/50">No results found. Try a different query or scope.</p>
                                        </div>
                                   ) : (
                                        <div>
                                             {results.map((r, i) => <ResultRow key={i} result={r} />)}
                                        </div>
                                   )}
                              </>
                         )}

                         {results === null && !isSearching && !error && (
                              <div className="flex flex-col items-center justify-center py-12 gap-2 text-center px-4">
                                   <Search className="w-8 h-8 text-black/10 dark:text-white/10" />
                                   <p className="text-sm text-black/40 dark:text-white/40">Enter a query above to search your library semantically.</p>
                              </div>
                         )}
                    </div>
               </div>
          </div>
     );
}
