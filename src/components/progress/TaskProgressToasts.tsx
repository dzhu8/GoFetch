"use client";

import { useMemo } from "react";

import { useTaskProgressActions, useTaskProgressEntries } from "@/components/progress/TaskProgressProvider";
import type { TaskProgressState } from "@/lib/embed/types";

const MAX_VISIBLE = 5;

const getProgressPercent = (progress: TaskProgressState): number => {
     if (progress.totalFiles > 0) {
          return Math.min(100, Math.round((progress.processedFiles / progress.totalFiles) * 100));
     }

     if (progress.phase === "completed") {
          return 100;
     }

     if (progress.phase === "parsing") {
          return 5;
     }

     if (progress.phase === "summarizing") {
          return 10;
     }

     return progress.phase === "embedding" ? 15 : 0;
};

const getPhaseLabel = (phase: TaskProgressState["phase"]): string => {
     switch (phase) {
          case "parsing":
               return "Parsing";
          case "summarizing":
               return "Summarizing";
          case "embedding":
               return "Embedding";
          case "completed":
               return "Completed";
          case "error":
               return "Error";
          default:
               return "Processing";
     }
};

const getSecondaryText = (progress: TaskProgressState): string => {
     if (progress.phase === "summarizing" && progress.totalFiles > 0) {
          return `${progress.processedFiles} / ${progress.totalFiles} snippets summarized`;
     }
     if (progress.phase === "embedding" && progress.totalFiles > 0) {
          return `${progress.processedFiles} / ${progress.totalFiles} documents embedded`;
     }
     if (progress.phase === "completed") {
          return "Initial embeddings ready.";
     }
     return progress.message || "Preparing project...";
};

const formatTokenCount = (tokens: number): string => {
     if (tokens >= 1_000_000) {
          return `${(tokens / 1_000_000).toFixed(1)}M`;
     }
     if (tokens >= 1_000) {
          return `${(tokens / 1_000).toFixed(1)}K`;
     }
     return tokens.toString();
};

export default function TaskProgressToasts() {
     const entries = useTaskProgressEntries();
     const { dismissProgressEntry } = useTaskProgressActions();

     const visibleEntries = useMemo(() => {
          return Object.values(entries)
               .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
               .slice(0, MAX_VISIBLE);
     }, [entries]);

     if (visibleEntries.length === 0) {
          return null;
     }

     return (
          <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3 w-full max-w-sm">
               {visibleEntries.map((progress) => {
                    const percent = getProgressPercent(progress);
                    const secondaryText = getSecondaryText(progress);
                    const phaseLabel = getPhaseLabel(progress.phase);
                    const showTokenBar =
                         progress.phase === "summarizing" &&
                         typeof progress.totalTokensOutput === "number" &&
                         progress.totalTokensOutput > 0;

                    return (
                         <div
                              key={progress.folderName}
                              className="w-full bg-light-primary/95 dark:bg-dark-primary/95 border border-light-200 dark:border-dark-200 rounded-xl p-4 shadow-lg backdrop-blur"
                         >
                              <div className="flex items-start justify-between gap-3">
                                   <div>
                                        <p className="text-xs text-black/50 dark:text-white/50">{phaseLabel}</p>
                                        <h3 className="text-sm font-semibold text-black dark:text-white">
                                             {progress.folderName}
                                        </h3>
                                   </div>
                                   <button
                                        type="button"
                                        onClick={() => dismissProgressEntry(progress.folderName)}
                                        className="text-xs text-black/60 dark:text-white/60 hover:text-black hover:dark:text-white"
                                   >
                                        {progress.phase === "completed" || progress.phase === "error" ? "Done" : "Hide"}
                                   </button>
                              </div>
                              <p className="mt-3 text-xs text-black/70 dark:text-white/70">{secondaryText}</p>
                              <div className="mt-3 w-full h-2 rounded-full bg-light-200 dark:bg-dark-200 overflow-hidden">
                                   <div
                                        className="h-full bg-[#F8B692] transition-all duration-300"
                                        style={{ width: `${percent}%` }}
                                   />
                              </div>
                              {showTokenBar && (
                                   <div className="mt-2">
                                        <div className="flex items-center justify-between text-[10px] text-black/50 dark:text-white/50 mb-1">
                                             <span>Tokens generated</span>
                                             <span>{formatTokenCount(progress.totalTokensOutput!)}</span>
                                        </div>
                                        <div className="w-full h-1.5 rounded-full bg-light-200 dark:bg-dark-200 overflow-hidden">
                                             <div
                                                  className="h-full bg-[#92C5F8] transition-all duration-300"
                                                  style={{
                                                       // Animate width based on token count, capped at 100%
                                                       // Use a logarithmic scale for better visualization
                                                       width: `${Math.min(100, Math.log10(progress.totalTokensOutput! + 1) * 20)}%`,
                                                  }}
                                             />
                                        </div>
                                   </div>
                              )}
                              {progress.error && <p className="mt-2 text-xs text-red-500">{progress.error}</p>}
                         </div>
                    );
               })}
          </div>
     );
}
