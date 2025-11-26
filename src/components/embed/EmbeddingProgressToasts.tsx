"use client";

import { useMemo } from "react";

import { useEmbeddingProgressActions, useEmbeddingProgressEntries } from "@/components/embed/EmbeddingProgressProvider";
import type { EmbeddingProgressState } from "@/lib/embed/types";

const MAX_VISIBLE = 5;

const getProgressPercent = (progress: EmbeddingProgressState): number => {
     if (progress.totalFiles > 0) {
          return Math.min(100, Math.round((progress.embeddedFiles / progress.totalFiles) * 100));
     }

     if (progress.phase === "completed") {
          return 100;
     }

     if (progress.phase === "parsing") {
          return 10;
     }

     return progress.phase === "embedding" ? 5 : 0;
};

const getSecondaryText = (progress: EmbeddingProgressState): string => {
     if (progress.phase === "embedding" && progress.totalFiles > 0) {
          return `${progress.embeddedFiles} / ${progress.totalFiles} files embedded`;
     }
     if (progress.phase === "completed") {
          return "Initial embeddings ready.";
     }
     return progress.message || "Preparing project embeddings...";
};

export default function EmbeddingProgressToasts() {
     const entries = useEmbeddingProgressEntries();
     const { dismissProgressEntry } = useEmbeddingProgressActions();

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

                    return (
                         <div
                              key={progress.folderName}
                              className="w-full bg-light-primary/95 dark:bg-dark-primary/95 border border-light-200 dark:border-dark-200 rounded-xl p-4 shadow-lg backdrop-blur"
                         >
                              <div className="flex items-start justify-between gap-3">
                                   <div>
                                        <p className="text-xs text-black/50 dark:text-white/50">Embedding</p>
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
                              {progress.error && <p className="mt-2 text-xs text-red-500">{progress.error}</p>}
                         </div>
                    );
               })}
          </div>
     );
}
