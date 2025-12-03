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
     const eventSourcesRef = useRef<Map<string, EventSource>>(new Map());

     const stopTrackingFolder = useCallback((folderName: string) => {
          const eventSource = eventSourcesRef.current.get(folderName);
          if (eventSource) {
               eventSource.close();
               eventSourcesRef.current.delete(folderName);
          }
     }, []);

     const clearAllEventSources = useCallback(() => {
          for (const eventSource of eventSourcesRef.current.values()) {
               eventSource.close();
          }
          eventSourcesRef.current.clear();
     }, []);

     const dismissProgressEntry = useCallback(
          (folderName: string) => {
               stopTrackingFolder(folderName);
               setEntries((prev) => {
                    if (!prev[folderName]) {
                         return prev;
                    }
                    const next = { ...prev };
                    delete next[folderName];
                    return next;
               });
          },
          [stopTrackingFolder]
     );

     const trackFolderEmbedding = useCallback(
          (folderName: string) => {
               const trimmedName = folderName.trim();
               if (!trimmedName) {
                    return;
               }

               // Close any existing connection for this folder
               stopTrackingFolder(trimmedName);

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

               // Create SSE connection
               const eventSource = new EventSource(`/api/folders/${encodeURIComponent(trimmedName)}/embedding-status`);

               eventSource.onmessage = (event) => {
                    try {
                         const progress = JSON.parse(event.data) as EmbeddingProgressState;
                         setEntries((prev) => ({
                              ...prev,
                              [trimmedName]: progress,
                         }));

                         // Close connection when embedding is complete or errored
                         if (progress.phase === "completed" || progress.phase === "error") {
                              stopTrackingFolder(trimmedName);
                         }
                    } catch (error) {
                         console.error("Error parsing SSE message:", error);
                    }
               };

               eventSource.onerror = () => {
                    // EventSource will automatically try to reconnect on error
                    // Only close if we're in an unrecoverable state
                    if (eventSource.readyState === EventSource.CLOSED) {
                         stopTrackingFolder(trimmedName);
                    }
               };

               eventSourcesRef.current.set(trimmedName, eventSource);
          },
          [stopTrackingFolder]
     );

     useEffect(() => {
          return () => {
               clearAllEventSources();
          };
     }, [clearAllEventSources]);

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
