"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
     ArrowLeft,
     AlertCircle,
     ExternalLink,
     FileText,
     Globe,
     Loader2,
     Network,
     ChevronDown,
} from "lucide-react";

interface RelatedPaper {
     id: number;
     paperId: number;
     title: string;
     authors: string | null;
     year: number | null;
     venue: string | null;
     abstract: string | null;
     doi: string | null;
     semanticScholarId: string | null;
     relevanceScore: number | null;
     bcScore: number | null;
     ccScore: number | null;
     rankMethod: string;
     embeddingModel: string | null;
     depth: number | null;
     createdAt: string;
}

interface PaperInfo {
     id: number;
     title: string | null;
     fileName: string;
     doi: string | null;
}

const ScoreBadge = ({ score, label, type }: { score: number; label?: string, type?: "BC" | "CC" }) => {
     const pct = Math.round(score * 100);
     const colour =
          pct >= 40
               ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20"
               : pct >= 15
                 ? "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20"
                 : "text-black/40 dark:text-white/40 bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10";
     return (
          <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border font-mono ${colour}`} title={label || "Relevance score"}>
               {type && <span className="opacity-50 font-bold mr-0.5">{type}</span>}
               {pct}%
          </span>
     );
};

export default function RelatedPapersPage() {
     const params = useParams();
     const router = useRouter();
     const paperId = params.id as string;

     const [paper, setPaper] = useState<PaperInfo | null>(null);
     const [relatedPapers, setRelatedPapers] = useState<RelatedPaper[]>([]);
     const [rankMethod, setRankMethod] = useState<string>("bibliographic");
     const [cachedMethods, setCachedMethods] = useState<string[]>([]);
     const [embeddingResultsStale, setEmbeddingResultsStale] = useState(false);
     const [isLoading, setIsLoading] = useState(true);
     const [isComputing, setIsComputing] = useState(false);
     const [error, setError] = useState<string | null>(null);
     const [isMethodDropdownOpen, setIsMethodDropdownOpen] = useState(false);

     const fetchData = useCallback(async (method?: string) => {
          try {
               setIsLoading(true);
               setError(null);

               // Fetch source paper info
               const paperRes = await fetch(`/api/papers/${paperId}`);
               if (paperRes.ok) {
                    const data = await paperRes.json();
                    if (data.paper) setPaper(data.paper);
               }

               // Fetch saved related papers (optionally for a specific method)
               const url = method
                    ? `/api/papers/${paperId}/related-papers?method=${encodeURIComponent(method)}`
                    : `/api/papers/${paperId}/related-papers`;
               const rpRes = await fetch(url);
               if (!rpRes.ok) throw new Error("Failed to fetch related papers");
               const rpData = await rpRes.json();
               let results = rpData.relatedPapers ?? [];
               
               // Sort by relevance score (which is already calculated based on rankMethod in the backend)
               results = results.sort((a: RelatedPaper, b: RelatedPaper) => 
                    (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
               );

               setRelatedPapers(results);
               setRankMethod(rpData.rankMethod ?? "bibliographic");
               setCachedMethods(rpData.cachedMethods ?? []);
               setEmbeddingResultsStale(rpData.embeddingResultsStale ?? false);
          } catch (err) {
               setError(err instanceof Error ? err.message : "Failed to load related papers");
          } finally {
               setIsLoading(false);
          }
     }, [paperId]);

     /** Switch to a method that already has cached results — no recompute needed. */
     const switchMethod = async (method: string) => {
          setIsMethodDropdownOpen(false);
          // Update global config so future Recompute uses this method
          await fetch("/api/config", {
               method: "POST",
               headers: { "Content-Type": "application/json" },
               body: JSON.stringify({ key: "personalization.graphRankMethod", value: method }),
          });
          await fetchData(method);
     };

     const handleCompute = async (selectedMethod?: string) => {
          setIsComputing(true);
          setError(null);
          setIsMethodDropdownOpen(false);
          try {
               // Update global config first if method changed
               if (selectedMethod && selectedMethod !== rankMethod) {
                    await fetch("/api/config", {
                         method: "POST",
                         headers: { "Content-Type": "application/json" },
                         body: JSON.stringify({
                              key: "personalization.graphRankMethod",
                              value: selectedMethod,
                         }),
                    });
                    setRankMethod(selectedMethod);
               }

               const res = await fetch(`/api/papers/${paperId}/related-papers`, { method: "POST" });
               if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || "Failed to compute related papers");
               }
               await fetchData(selectedMethod ?? rankMethod);
          } catch (err) {
               setError(err instanceof Error ? err.message : "Failed to compute related papers");
          } finally {
               setIsComputing(false);
          }
     };

     useEffect(() => {
          fetchData();
     }, [fetchData]);

     const sourceTitle = paper?.title ?? paper?.fileName ?? "Paper";
     const sourceDoi = paper?.doi;
     const seedUrl = sourceDoi
          ? `https://doi.org/${encodeURIComponent(sourceDoi)}`
          : null;

     return (
          <div className="h-full flex flex-col">
               {/* Header */}
               <div className="px-6 pt-6 pb-4 max-w-4xl mx-auto w-full">
                    <button
                         onClick={() => router.back()}
                         className="inline-flex items-center gap-1.5 text-sm text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white transition-colors mb-4"
                    >
                         <ArrowLeft className="w-4 h-4" />
                         Back
                    </button>

                    <div className="flex items-start gap-3">
                         <div className="p-2 rounded-xl bg-[#F8B692]/10 shrink-0 mt-0.5">
                              <Network className="w-5 h-5 text-[#F8B692]" />
                         </div>
                         <div className="min-w-0">
                              <h1 className="text-xl font-semibold text-black dark:text-white leading-tight">
                                   Related Papers
                              </h1>
                              <p className="text-sm text-black/50 dark:text-white/50 mt-0.5 truncate">
                                   {seedUrl ? (
                                        <a
                                             href={seedUrl}
                                             target="_blank"
                                             rel="noopener noreferrer"
                                             className="hover:text-[#F8B692] transition-colors"
                                        >
                                             {sourceTitle}
                                        </a>
                                   ) : (
                                        sourceTitle
                                   )}
                              </p>
                         </div>
                    {!isLoading && (
                              <div className="ml-auto flex items-center gap-2">
                                   {embeddingResultsStale && rankMethod === "embedding" && (
                                        <div className="flex items-center gap-1 text-[11px] text-amber-500 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded-lg">
                                             <AlertCircle className="w-3 h-3" />
                                             Model changed
                                        </div>
                                   )}
                                   <div className="relative">
                                   <div className="flex items-center gap-0.5">
                                        <button
                                             type="button"
                                             onClick={() => handleCompute()}
                                             disabled={isComputing}
                                             className="inline-flex items-center gap-2 px-3 py-1.5 rounded-l-lg text-xs font-medium bg-[#F8B692]/10 text-[#F8B692] hover:bg-[#F8B692]/20 disabled:opacity-50 transition-colors border-r border-[#F8B692]/20"
                                             title={`Compute using ${rankMethod === "embedding" ? "Embedding Similarity" : "Bibliographic (BC+CC)"}`}
                                        >
                                             {isComputing ? (
                                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                             ) : (
                                                  <Network className="w-3.5 h-3.5" />
                                             )}
                                             {isComputing ? "Computing..." : "Recompute"}
                                        </button>
                                        <button
                                             type="button"
                                             onClick={() => setIsMethodDropdownOpen(!isMethodDropdownOpen)}
                                             disabled={isComputing}
                                             className="px-2 py-1.5 rounded-r-lg bg-[#F8B692]/10 text-[#F8B692] hover:bg-[#F8B692]/20 disabled:opacity-50 transition-colors"
                                        >
                                             <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isMethodDropdownOpen ? "rotate-180" : ""}`} />
                                        </button>
                                   </div>

                                   {isMethodDropdownOpen && (
                                        <div className="absolute right-0 mt-2 w-56 rounded-xl bg-white dark:bg-[#1a1a1a] border border-light-200 dark:border-dark-200 shadow-xl z-50 overflow-hidden">
                                             <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-black/40 dark:text-white/40 font-bold border-b border-light-200 dark:border-dark-200">
                                                  Switch View
                                             </div>
                                             {(["bibliographic", "embedding"] as const).map((m) => {
                                                  const isCurrent = rankMethod === m;
                                                  const isCached = cachedMethods.includes(m);
                                                  const isStale = m === "embedding" && embeddingResultsStale;
                                                  return (
                                                       <button
                                                            key={m}
                                                            onClick={() => isCached && !isCurrent ? switchMethod(m) : undefined}
                                                            disabled={isCurrent || !isCached}
                                                            className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-center justify-between gap-2
                                                                 ${isCurrent ? "text-[#F8B692] font-semibold bg-[#F8B692]/5 cursor-default" : ""}
                                                                 ${isCached && !isCurrent ? "hover:bg-[#F8B692]/5 text-black/70 dark:text-white/70 cursor-pointer" : ""}
                                                                 ${!isCached ? "text-black/30 dark:text-white/30 cursor-not-allowed" : ""}
                                                            `}
                                                       >
                                                            <span>{m === "embedding" ? "Embedding Similarity" : "Bibliographic (BC+CC)"}</span>
                                                            <span className="shrink-0 text-[10px]">
                                                                 {isCurrent ? (
                                                                      <span className="text-[#F8B692]">active</span>
                                                                 ) : isStale ? (
                                                                      <span className="text-amber-500">stale</span>
                                                                 ) : isCached ? (
                                                                      <span className="text-green-500">cached</span>
                                                                 ) : (
                                                                      <span className="opacity-40">not computed</span>
                                                                 )}
                                                            </span>
                                                       </button>
                                                  );
                                             })}
                                             <div className="border-t border-light-200 dark:border-dark-200 p-1">
                                                  <button
                                                       onClick={() => { setIsMethodDropdownOpen(false); handleCompute(); }}
                                                       className="w-full text-left px-3 py-1.5 text-xs text-black/50 dark:text-white/50 hover:text-[#F8B692] hover:bg-[#F8B692]/5 transition-colors rounded-lg"
                                                  >
                                                       Force recompute current method
                                                  </button>
                                             </div>
                                        </div>
                                   )}
                              </div>
                         </div>
                    )}
               </div>
          </div>
               {/* Error */}
               {error && (
                    <div className="mx-6 max-w-4xl mx-auto w-full mb-4 flex items-center gap-2 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm">
                         <AlertCircle className="w-4 h-4 shrink-0" />
                         {error}
                    </div>
               )}

               {/* Content */}
               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    <div className="max-w-4xl mx-auto w-full">
                         {isLoading ? (
                              <div className="flex flex-col items-center justify-center py-16">
                                   <Loader2 className="w-8 h-8 animate-spin text-black/40 dark:text-white/40 mb-3" />
                                   <p className="text-sm text-black/50 dark:text-white/50">Loading related papers...</p>
                              </div>
                         ) : isComputing ? (
                              <div className="flex flex-col items-center justify-center py-16 gap-3">
                                   <div className="relative">
                                        <div className="absolute inset-0 animate-ping rounded-full bg-[#F8B692]/20" />
                                        <div className="relative rounded-full bg-[#F8B692]/10 p-4">
                                             <Loader2 className="w-8 h-8 animate-spin text-[#F8B692]" />
                                        </div>
                                   </div>
                                   <p className="text-sm text-black/60 dark:text-white/60">Computing related papers&hellip;</p>
                                   <p className="text-xs text-black/40 dark:text-white/40">This may take a moment</p>
                              </div>
                         ) : relatedPapers.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-16 text-center">
                                   <FileText className="w-12 h-12 text-black/20 dark:text-white/20 mb-3" />
                                   <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                        {cachedMethods.length === 0
                                             ? "No related papers yet"
                                             : `No results for ${rankMethod === "embedding" ? "embedding similarity" : "bibliographic"} method`}
                                   </p>
                                   <p className="text-sm text-black/50 dark:text-white/50 mb-4">
                                        {cachedMethods.length === 0
                                             ? "Click \u201cRecompute\u201d to find related papers from this paper\u2019s references."
                                             : `Click \u201cRecompute\u201d to compute ${rankMethod === "embedding" ? "embedding similarity" : "bibliographic (BC+CC)"} results.`}
                                   </p>
                              </div>
                         ) : (
                              <>
                                   <p className="text-xs text-black/40 dark:text-white/40 mb-1">
                                        {relatedPapers.length} related paper{relatedPapers.length !== 1 ? "s" : ""}
                                   </p>
                                   <p className="text-[10px] text-black/40 dark:text-white/40 mb-3 ml-0.5">
                                        {rankMethod === "embedding" ? (
                                             <span className="font-mono text-[#F8B692]">Ranked by Semantic Similarity</span>
                                        ) : (
                                             <>
                                                  Scores: <span className="font-mono">D#</span> = discovery depth &nbsp;·&nbsp;{" "}
                                                  <span className="font-mono">BC</span> = bibliographic coupling &nbsp;·&nbsp;{" "}
                                                  <span className="font-mono">CC</span> = co-citation
                                             </>
                                        )}
                                   </p>
                                   <div className="rounded-2xl border border-light-200 dark:border-dark-200 divide-y divide-light-200/60 dark:divide-dark-200/60 bg-light-secondary dark:bg-dark-secondary overflow-hidden">
                                        {relatedPapers.map((rp, i) => {
                                             const url = rp.doi
                                                  ? `https://doi.org/${encodeURIComponent(rp.doi)}`
                                                  : rp.semanticScholarId
                                                    ? `https://www.semanticscholar.org/paper/${rp.semanticScholarId}`
                                                    : null;
                                             return (
                                                  <div key={rp.id} className="group px-4 py-3">
                                                       <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                            <span className="text-[10px] text-black/30 dark:text-white/30 font-mono w-5 text-right shrink-0">
                                                                 #{i + 1}
                                                            </span>
                                                            {rp.semanticScholarId && (
                                                                 <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-[#F8B692]/15 text-[#F8B692] border border-[#F8B692]/20 font-medium">
                                                                      <Globe className="w-2.5 h-2.5" />
                                                                      S2
                                                                 </span>
                                                            )}
                                                            <div className="ml-auto flex items-center gap-1">
                                                                 {rankMethod !== "embedding" && (
                                                                      <>
                                                                           {rp.depth != null && (
                                                                                <span
                                                                                     className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border font-mono text-black/40 dark:text-white/40 bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10"
                                                                                     title={`Discovery depth: ${rp.depth} (${rp.depth === 1 ? "direct reference or citation" : `${rp.depth} hops from source`})`}
                                                                                >
                                                                                     D{rp.depth}
                                                                                </span>
                                                                           )}
                                                                           {rp.bcScore != null && (
                                                                                <ScoreBadge
                                                                                     score={rp.bcScore}
                                                                                     type="BC"
                                                                                     label={`Bibliographic coupling: ${Math.round(rp.bcScore * 100)}%`}
                                                                                />
                                                                           )}
                                                                           {rp.ccScore != null && (
                                                                                <ScoreBadge
                                                                                     score={rp.ccScore}
                                                                                     type="CC"
                                                                                     label={`Co-citation: ${Math.round(rp.ccScore * 100)}%`}
                                                                                />
                                                                           )}
                                                                      </>
                                                                 )}
                                                            </div>
                                                       </div>
                                                       {url ? (
                                                            <a
                                                                 href={url}
                                                                 target="_blank"
                                                                 rel="noopener noreferrer"
                                                                 className="inline-flex items-start gap-1.5 text-sm font-medium text-[#24A0ED] hover:underline leading-snug"
                                                            >
                                                                 {rp.title}
                                                                 <ExternalLink className="w-3 h-3 mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                                            </a>
                                                       ) : (
                                                            <p className="text-sm font-medium text-black dark:text-white leading-snug">
                                                                 {rp.title}
                                                            </p>
                                                       )}
                                                       {(rp.authors || rp.year || rp.venue) && (
                                                            <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
                                                                 {[rp.authors, rp.year, rp.venue].filter(Boolean).join(" · ")}
                                                            </p>
                                                       )}
                                                       {rp.abstract && (
                                                            <p className="text-xs text-black/60 dark:text-white/60 mt-1 leading-relaxed line-clamp-3">
                                                                 {rp.abstract}
                                                            </p>
                                                       )}
                                                  </div>
                                             );
                                        })}
                                   </div>
                              </>
                         )}
                    </div>
               </div>
          </div>
     );
}
