"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { EmbeddingProgressState } from "@/lib/embed/types";

interface EmbeddingProgressActions {
     trackFolderEmbedding: (folderName: string) => void;
     dismissProgressEntry: (folderName: string) => void;
}

const EmbeddingProgressStateContext = createContext<Record<string, EmbeddingProgressState> | null>(null);
const EmbeddingProgressActionsContext = createContext<EmbeddingProgressActions | null>(null);

const INITIAL_PROGRESS_MESSAGE = "Analyzing project files...";

export function EmbeddingProgressProvider({ children }: { children: React.ReactNode }) {
     const [entries, setEntries] = useState<Record<string, EmbeddingProgressState>>({});
     const pollingHandlesRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

     const stopPollingFolder = useCallback((folderName: string) => {
          const handle = pollingHandlesRef.current.get(folderName);
          if (handle) {
               clearTimeout(handle);
               pollingHandlesRef.current.delete(folderName);
          }
     }, []);

     const clearAllPolling = useCallback(() => {
          for (const handle of pollingHandlesRef.current.values()) {
               clearTimeout(handle);
          }
          pollingHandlesRef.current.clear();
     }, []);

     const dismissProgressEntry = useCallback(
          (folderName: string) => {
               stopPollingFolder(folderName);
               setEntries((prev) => {
                    if (!prev[folderName]) {
                         return prev;
                    }
                    const next = { ...prev };
                    delete next[folderName];
                    return next;
               });
          },
          [stopPollingFolder]
     );

     const trackFolderEmbedding = useCallback(
          (folderName: string) => {
               const trimmedName = folderName.trim();
               if (!trimmedName) {
                    return;
               }

               stopPollingFolder(trimmedName);
               const now = new Date().toISOString();
               setEntries((prev) => ({
                    ...prev,
                    [trimmedName]: {
                         folderName: trimmedName,
                         phase: "parsing",
                         totalFiles: 0,
                         embeddedFiles: 0,
                         message: INITIAL_PROGRESS_MESSAGE,
                         startedAt: now,
                         updatedAt: now,
                    },
               }));

               const poll = async () => {
                    try {
                         const res = await fetch(`/api/folders/${encodeURIComponent(trimmedName)}/embedding-status`, {
                              cache: "no-store",
                         });

                         if (!res.ok) {
                              throw new Error("Failed to fetch embedding progress");
                         }

                         const data = (await res.json().catch(() => null)) as {
                              progress?: EmbeddingProgressState;
                         } | null;

                         const progress = data?.progress;
                         if (progress) {
                              setEntries((prev) => ({
                                   ...prev,
                                   [trimmedName]: progress,
                              }));

                              if (progress.phase === "completed" || progress.phase === "error") {
                                   stopPollingFolder(trimmedName);
                                   return;
                              }
                         }
                    } catch (error) {
                         console.error("Error polling embedding progress:", error);
                    }

                    const timeoutId = setTimeout(poll, 2000);
                    pollingHandlesRef.current.set(trimmedName, timeoutId);
               };

               poll();
          },
          [stopPollingFolder]
     );

     useEffect(() => {
          return () => {
               clearAllPolling();
          };
     }, [clearAllPolling]);

     const actions = useMemo<EmbeddingProgressActions>(
          () => ({
               trackFolderEmbedding,
               dismissProgressEntry,
          }),
          [trackFolderEmbedding, dismissProgressEntry]
     );

     return (
          <EmbeddingProgressActionsContext.Provider value={actions}>
               <EmbeddingProgressStateContext.Provider value={entries}>
                    {children}
               </EmbeddingProgressStateContext.Provider>
          </EmbeddingProgressActionsContext.Provider>
     );
}

export function useEmbeddingProgressActions(): EmbeddingProgressActions {
     const context = useContext(EmbeddingProgressActionsContext);
     if (!context) {
          throw new Error("useEmbeddingProgressActions must be used within EmbeddingProgressProvider");
     }
     return context;
}

export function useEmbeddingProgressEntries(): Record<string, EmbeddingProgressState> {
     const context = useContext(EmbeddingProgressStateContext);
     if (!context) {
          throw new Error("useEmbeddingProgressEntries must be used within EmbeddingProgressProvider");
     }
     return context;
}
