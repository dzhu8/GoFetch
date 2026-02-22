"use client";

import { ExternalLink, FileText, Globe, X } from "lucide-react";
import type {
     RelatedPapersResponse,
     PaperSearchResults,
     SearchResult,
} from "@/app/api/paddleocr/related-papers/route";

export type { RelatedPapersResponse, PaperSearchResults, SearchResult };

const DomainBadge = ({ domain }: { domain: string }) => {
     const label = domain.replace(/^www\./, "").split(".").slice(0, 2).join(".");
     return (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-[#F8B692]/15 text-[#F8B692] border border-[#F8B692]/20 font-medium">
               <Globe size={10} />
               {label}
          </span>
     );
};

const ResultCard = ({ result }: { result: SearchResult }) => (
     <div className="group py-3 px-1">
          <div className="flex items-start gap-2 mb-1">
               {result.domain && <DomainBadge domain={result.domain} />}
               {result.isAcademic && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 font-medium">
                         Academic
                    </span>
               )}
          </div>

          <a
               href={result.url}
               target="_blank"
               rel="noopener noreferrer"
               className="inline-flex items-start gap-1.5 text-sm font-medium text-[#24A0ED] hover:underline leading-snug"
          >
               {result.title}
               <ExternalLink size={12} className="mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>

          {result.authors && (
               <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
                    {result.authors}
                    {result.year ? ` · ${result.year}` : ""}
                    {result.venue ? ` · ${result.venue}` : ""}
               </p>
          )}

          {result.snippet && (
               <p className="text-xs text-black/60 dark:text-white/60 mt-1 leading-relaxed line-clamp-3">
                    {result.snippet}
               </p>
          )}
     </div>
);

const CitationGroup = ({ group }: { group: PaperSearchResults }) => {
     if (group.results.length === 0) return null;

     return (
          <div className="border-b border-light-200/40 dark:border-dark-200/40 last:border-0 pb-2 mb-2 last:pb-0 last:mb-0">
               <p className="text-xs font-medium text-black/40 dark:text-white/40 uppercase tracking-wider mb-1 px-1">
                    Searched: &quot;{group.query.length > 80 ? group.query.slice(0, 80) + "…" : group.query}&quot;
               </p>
               {group.results.map((result, i) => (
                    <ResultCard key={`${result.url}-${i}`} result={result} />
               ))}
          </div>
     );
};

const RelatedPapersPanel = ({
     data,
     onClose,
}: {
     data: RelatedPapersResponse;
     onClose: () => void;
}) => {
     const totalResults = data.results.reduce((sum, g) => sum + g.results.length, 0);

     return (
          <div className="w-full space-y-2">
               {/* Header */}
               <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                         <div className="p-1.5 rounded-lg bg-[#F8B692]/10">
                              <FileText size={18} className="text-[#F8B692]" />
                         </div>
                         <div>
                              <h3 className="text-black dark:text-white font-medium text-lg leading-tight">
                                   {data.pdfTitle} Related Papers
                              </h3>
                              <p className="text-xs text-black/50 dark:text-white/50">
                                   {data.totalCitations} citations · {totalResults} results found
                                   {data.academicDomains.length > 0 && (
                                        <> · Academic sources: {data.academicDomains.join(", ")}</>
                                   )}
                              </p>
                         </div>
                    </div>
                    <button
                         onClick={onClose}
                         className="p-1.5 rounded-lg text-black/40 dark:text-white/40 hover:bg-light-200/60 dark:hover:bg-dark-200/60 transition-colors"
                    >
                         <X size={16} />
                    </button>
               </div>

               {/* Scrollable results container */}
               <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-light-200 dark:border-dark-200 bg-light-secondary/50 dark:bg-dark-secondary/50 p-4 scrollbar-thin scrollbar-thumb-light-200 dark:scrollbar-thumb-dark-200">
                    {data.results.filter((g) => g.results.length > 0).length === 0 ? (
                         <p className="text-sm text-black/60 dark:text-white/60 text-center py-8">
                              No results found for the extracted citations.
                         </p>
                    ) : (
                         data.results
                              .filter((g) => g.results.length > 0)
                              .map((group, i) => <CitationGroup key={i} group={group} />)
                    )}
               </div>
          </div>
     );
};

export default RelatedPapersPanel;
