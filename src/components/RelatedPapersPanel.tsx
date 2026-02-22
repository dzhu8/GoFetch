"use client";

import { ExternalLink, FileText, Globe, X } from "lucide-react";
import type { RankedPaper, RelatedPapersResponse } from "@/app/api/related-papers/route";

export type { RankedPaper, RelatedPapersResponse };

const DomainBadge = ({ domain }: { domain: string }) => {
     const label = domain.replace(/^www\./, "").split(".").slice(0, 2).join(".");
     return (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-[#F8B692]/15 text-[#F8B692] border border-[#F8B692]/20 font-medium">
               <Globe size={10} />
               {label}
          </span>
     );
};

const ScoreBadge = ({ score, label }: { score: number; label: string }) => {
     const pct = Math.round(score * 100);
     const colour =
          pct >= 40
               ? "text-green-600 dark:text-green-400 bg-green-500/10 border-green-500/20"
               : pct >= 15
                 ? "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/20"
                 : "text-black/40 dark:text-white/40 bg-black/5 dark:bg-white/5 border-black/10 dark:border-white/10";
     return (
          <span
               className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${colour}`}
               title={label}
          >
               {pct}%
          </span>
     );
};

const PaperCard = ({ paper, rank }: { paper: RankedPaper; rank: number }) => (
     <div className="group py-3 px-1 border-b border-light-200/40 dark:border-dark-200/40 last:border-0">
          {/* Badges row */}
          <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
               <span className="text-[10px] text-black/30 dark:text-white/30 font-mono w-5 text-right shrink-0">
                    #{rank}
               </span>
               {paper.domain && <DomainBadge domain={paper.domain} />}
               {paper.isAcademic && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 font-medium">
                         Academic
                    </span>
               )}
               <span className="ml-auto flex items-center gap-1">
                    <ScoreBadge
                         score={paper.bcScore}
                         label={`Bibliographic coupling: ${Math.round(paper.bcScore * 100)}%`}
                    />
                    <ScoreBadge
                         score={paper.ccScore}
                         label={`Co-citation: ${Math.round(paper.ccScore * 100)}%`}
                    />
               </span>
          </div>

          {/* Title */}
          <a
               href={paper.url || `https://www.semanticscholar.org/paper/${paper.paperId}`}
               target="_blank"
               rel="noopener noreferrer"
               className="inline-flex items-start gap-1.5 text-sm font-medium text-[#24A0ED] hover:underline leading-snug"
          >
               {paper.title}
               <ExternalLink
                    size={12}
                    className="mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
               />
          </a>

          {/* Meta */}
          {(paper.authors || paper.year || paper.venue) && (
               <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
                    {[paper.authors, paper.year, paper.venue].filter(Boolean).join(" · ")}
               </p>
          )}

          {/* Abstract snippet */}
          {paper.snippet && (
               <p className="text-xs text-black/60 dark:text-white/60 mt-1 leading-relaxed line-clamp-3">
                    {paper.snippet}
               </p>
          )}
     </div>
);

const RelatedPapersPanel = ({
     data,
     onClose,
}: {
     data: RelatedPapersResponse;
     onClose: () => void;
}) => {
     const seedUrl = data.pdfDoi
          ? `https://doi.org/${encodeURIComponent(data.pdfDoi)}`
          : data.seedPaperId
            ? `https://www.semanticscholar.org/paper/${data.seedPaperId}`
            : null;

     return (
          <div className="w-full space-y-2">
               {/* Header */}
               <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                         <div className="p-1.5 rounded-lg bg-[#F8B692]/10 shrink-0">
                              <FileText size={18} className="text-[#F8B692]" />
                         </div>
                         <div className="min-w-0">
                              <h3 className="text-black dark:text-white font-medium text-lg leading-tight truncate">
                                   {seedUrl ? (
                                        <a
                                             href={seedUrl}
                                             target="_blank"
                                             rel="noopener noreferrer"
                                             className="hover:underline"
                                        >
                                             {data.pdfTitle}
                                        </a>
                                   ) : (
                                        data.pdfTitle
                                   )}
                              </h3>
                              <p className="text-xs text-black/50 dark:text-white/50">
                                   {data.rankedPapers.length} related papers
                                   {data.totalCandidates > 0 && (
                                        <> · {data.totalCandidates.toLocaleString()} candidates</>
                                   )}
                                   {data.resolvedCitations > 0 && (
                                        <> · {data.resolvedCitations} citations resolved</>
                                   )}
                              </p>
                         </div>
                    </div>
                    <button
                         onClick={onClose}
                         className="p-1.5 rounded-lg text-black/40 dark:text-white/40 hover:bg-light-200/60 dark:hover:bg-dark-200/60 transition-colors shrink-0"
                    >
                         <X size={16} />
                    </button>
               </div>

               {/* Score legend */}
               {data.rankedPapers.length > 0 && (
                    <p className="text-[10px] text-black/40 dark:text-white/40 px-1">
                         Scores: <span className="font-mono">BC</span> = bibliographic coupling &nbsp;·&nbsp;{" "}
                         <span className="font-mono">CC</span> = co-citation
                    </p>
               )}

               {/* Ranked paper list */}
               <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-light-200 dark:border-dark-200 bg-light-secondary/50 dark:bg-dark-secondary/50 px-4 py-2 scrollbar-thin scrollbar-thumb-light-200 dark:scrollbar-thumb-dark-200">
                    {data.rankedPapers.length === 0 ? (
                         <p className="text-sm text-black/60 dark:text-white/60 text-center py-8">
                              No related papers found. This may occur when citations could not be
                              resolved in Semantic Scholar.
                         </p>
                    ) : (
                         data.rankedPapers.map((paper, i) => (
                              <PaperCard key={paper.paperId} paper={paper} rank={i + 1} />
                         ))
                    )}
               </div>
          </div>
     );
};

export default RelatedPapersPanel;

