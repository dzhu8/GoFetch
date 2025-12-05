"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import type { TaskProgressState } from "@/lib/embed/types";

interface TaskProgressActions {
     trackFolderTask: (folderName: string) => void;
     dismissProgressEntry: (folderName: string) => void;
}

const TaskProgressStateContext = createContext<Record<string, TaskProgressState> | null>(null);
const TaskProgressActionsContext = createContext<TaskProgressActions | null>(null);

const INITIAL_PROGRESS_MESSAGE = "Analyzing project files...";

export function TaskProgressProvider({ children }: { children: React.ReactNode }) {
     const [entries, setEntries] = useState<Record<string, TaskProgressState>>({});
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

     const trackFolderTask = useCallback(
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
                         processedFiles: 0,
                         message: INITIAL_PROGRESS_MESSAGE,
                         startedAt: now,
                         updatedAt: now,
                    },
               }));

               // Create SSE connection
               const eventSource = new EventSource(`/api/folders/${encodeURIComponent(trimmedName)}/task-status`);

               eventSource.onmessage = (event) => {
                    try {
                         const progress = JSON.parse(event.data) as TaskProgressState;
                         setEntries((prev) => ({
                              ...prev,
                              [trimmedName]: progress,
                         }));

                         // Close connection when task is complete or errored
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

     const actions = useMemo<TaskProgressActions>(
          () => ({
               trackFolderTask,
               dismissProgressEntry,
          }),
          [trackFolderTask, dismissProgressEntry]
     );

     return (
          <TaskProgressActionsContext.Provider value={actions}>
               <TaskProgressStateContext.Provider value={entries}>{children}</TaskProgressStateContext.Provider>
          </TaskProgressActionsContext.Provider>
     );
}

export function useTaskProgressActions(): TaskProgressActions {
     const context = useContext(TaskProgressActionsContext);
     if (!context) {
          throw new Error("useTaskProgressActions must be used within TaskProgressProvider");
     }
     return context;
}

export function useTaskProgressEntries(): Record<string, TaskProgressState> {
     const context = useContext(TaskProgressStateContext);
     if (!context) {
          throw new Error("useTaskProgressEntries must be used within TaskProgressProvider");
     }
     return context;
}
