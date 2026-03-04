"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface PdfParseJob {
     /** Unique key — `folderId:fileName:timestamp` */
     id: string;
     fileName: string;
     folderName: string;
     status: "queued" | "uploading" | "processing" | "complete" | "error";
     message: string;
     startedAt: string;
}

interface QueueEntry {
     id: string;
     file: File;
     folderId: number;
}

interface PdfParseActions {
     /** Enqueue a new parse job. Starts immediately if nothing is running, otherwise waits. */
     startParseJob: (file: File, folderId: number, folderName: string) => void;
     /** Remove a finished/errored/queued job from the list. */
     dismissJob: (id: string) => void;
}

const PdfParseJobsContext = createContext<PdfParseJob[]>([]);
const PdfParseActionsContext = createContext<PdfParseActions | null>(null);

export function PdfParseProvider({ children }: { children: React.ReactNode }) {
     const [jobs, setJobs] = useState<PdfParseJob[]>([]);
     const queue = useRef<QueueEntry[]>([]);
     const isProcessing = useRef(false);

     const updateJob = useCallback((id: string, patch: Partial<PdfParseJob>) => {
          setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
     }, []);

     const dismissJob = useCallback((id: string) => {
          // Also remove from the pending queue if it hasn't started yet
          queue.current = queue.current.filter((e) => e.id !== id);
          setJobs((prev) => prev.filter((j) => j.id !== id));
     }, []);

     // processNext is declared with useCallback so the async IIFE always calls
     // the latest version via the stable ref trick isn't needed — updateJob is
     // stable (empty deps) so processNext is also stable.
     const processNext = useCallback(() => {
          const entry = queue.current.shift();
          if (!entry) {
               isProcessing.current = false;
               return;
          }

          isProcessing.current = true;
          const { id, file, folderId } = entry;

          updateJob(id, { status: "uploading", message: "Uploading PDF..." });

          (async () => {
               try {
                    const formData = new FormData();
                    formData.append("pdf", file);
                    formData.append("folderId", String(folderId));

                    const res = await fetch("/api/papers/upload", {
                         method: "POST",
                         body: formData,
                    });

                    if (!res.ok) {
                         const err = await res.json().catch(() => ({}));
                         throw new Error(err.error || "Upload failed");
                    }

                    const reader = res.body?.getReader();
                    const decoder = new TextDecoder();

                    if (reader) {
                         let done = false;
                         while (!done) {
                              const { value, done: streamDone } = await reader.read();
                              done = streamDone;
                              if (value) {
                                   const lines = decoder.decode(value).split("\n").filter(Boolean);
                                   for (const line of lines) {
                                        try {
                                             const event = JSON.parse(line);
                                             if (event.type === "status") {
                                                  updateJob(id, { status: "processing", message: event.message });
                                             } else if (event.type === "complete") {
                                                  const title = event.paper?.title || file.name;
                                                  updateJob(id, {
                                                       status: "complete",
                                                       message: `"${title}" saved to library.`,
                                                  });
                                             } else if (event.type === "error") {
                                                  throw new Error(event.message || "Processing failed");
                                             }
                                        } catch (inner) {
                                             if (inner instanceof Error) throw inner;
                                        }
                                   }
                              }
                         }
                    }
               } catch (err: any) {
                    updateJob(id, {
                         status: "error",
                         message: err.message ?? "Upload failed.",
                    });
               } finally {
                    // Always advance the queue when a job finishes
                    processNext();
               }
          })();
     }, [updateJob]);

     const startParseJob = useCallback(
          (file: File, folderId: number, folderName: string) => {
               const id = `${folderId}:${file.name}:${Date.now()}`;

               const job: PdfParseJob = {
                    id,
                    fileName: file.name,
                    folderName,
                    status: "queued",
                    message: "Waiting in queue...",
                    startedAt: new Date().toISOString(),
               };

               setJobs((prev) => [...prev, job]);
               queue.current.push({ id, file, folderId });

               if (!isProcessing.current) {
                    processNext();
               }
          },
          [processNext],
     );

     const actions = useMemo<PdfParseActions>(() => ({ startParseJob, dismissJob }), [startParseJob, dismissJob]);

     return (
          <PdfParseActionsContext.Provider value={actions}>
               <PdfParseJobsContext.Provider value={jobs}>{children}</PdfParseJobsContext.Provider>
          </PdfParseActionsContext.Provider>
     );
}

export function usePdfParseActions(): PdfParseActions {
     const ctx = useContext(PdfParseActionsContext);
     if (!ctx) throw new Error("usePdfParseActions must be used within PdfParseProvider");
     return ctx;
}

export function usePdfParseJobs(): PdfParseJob[] {
     return useContext(PdfParseJobsContext);
}
