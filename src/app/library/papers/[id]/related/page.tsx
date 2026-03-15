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
     const [isLoading, setIsLoading] = useState(true);
     const [isComputing, setIsComputing] = useState(false);
     const [error, setError] = useState<string | null>(null);

     const fetchData = useCallback(async () => {
          try {
               setIsLoading(true);
               setError(null);

               // Fetch source paper info
               const paperRes = await fetch(`/api/papers/${paperId}`);
               if (paperRes.ok) {
                    const data = await paperRes.json();
                    if (data.paper) setPaper(data.paper);
               }

               // Fetch saved related papers
               const rpRes = await fetch(`/api/papers/${paperId}/related-papers`);
               if (!rpRes.ok) throw new Error("Failed to fetch related papers");
               const rpData = await rpRes.json();
               setRelatedPapers(rpData.relatedPapers ?? []);
          } catch (err) {
               setError(err instanceof Error ? err.message : "Failed to load related papers");
          } finally {
               setIsLoading(false);
          }
     }, [paperId]);

     const handleCompute = async () => {
          setIsComputing(true);
          setError(null);
          try {
               const res = await fetch(`/api/papers/${paperId}/related-papers`, { method: "POST" });
               if (!res.ok) {
                    const data = await res.json();
                    throw new Error(data.error || "Failed to compute related papers");
               }
               await fetchData();
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
                              <button
                                   type="button"
                                   onClick={handleCompute}
                                   disabled={isComputing}
                                   className="ml-auto shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#F8B692]/10 text-[#F8B692] hover:bg-[#F8B692]/20 disabled:opacity-50 transition-colors"
                                   title="Recompute related papers"
                              >
                                   {isComputing ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                   ) : (
                                        <Network className="w-3.5 h-3.5" />
                                   )}
                                   {isComputing ? "Computing..." : "Recompute"}
                              </button>
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
                                        No related papers yet
                                   </p>
                                   <p className="text-sm text-black/50 dark:text-white/50 mb-4">
                                        Click &ldquo;Recompute&rdquo; to find related papers from this paper&rsquo;s references.
                                   </p>
                              </div>
                         ) : (
                              <>
                                   <p className="text-xs text-black/40 dark:text-white/40 mb-1">
                                        {relatedPapers.length} related paper{relatedPapers.length !== 1 ? "s" : ""}
                                   </p>
                                   <p className="text-[10px] text-black/40 dark:text-white/40 mb-3 ml-0.5">
                                        Scores: <span className="font-mono">BC</span> = bibliographic coupling &nbsp;·&nbsp;{" "}
                                        <span className="font-mono">CC</span> = co-citation
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
                                                                      Semantic Scholar
                                                                 </span>
                                                            )}
                                                            <div className="ml-auto flex items-center gap-1">
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
