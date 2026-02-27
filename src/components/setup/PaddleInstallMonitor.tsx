"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

const STORAGE_KEY = "paddleocr_install_pending";

type InstallStatus = "running" | "done" | "error";

/**
 * Checks localStorage on mount for a pending PaddleOCR install (set by the
 * setup wizard's Finish button).  If found, streams the install in the
 * background and shows:
 *  - a small bottom-right card while running
 *  - a centered success modal when done
 *  - a centered error modal on failure
 */
export default function PaddleInstallMonitor() {
     const [status, setStatus] = useState<InstallStatus | null>(null);
     const [errorMessage, setErrorMessage] = useState<string | null>(null);
     const [logLines, setLogLines] = useState<string[]>([]);
     const [lastOutputLine, setLastOutputLine] = useState<string>("");
     const logScrollRef = useRef<HTMLDivElement>(null);

     useEffect(() => {
          const pythonPath = localStorage.getItem(STORAGE_KEY);
          if (!pythonPath) return;
          localStorage.removeItem(STORAGE_KEY);
          setStatus("running");

          const run = async () => {
               try {
                    const res = await fetch("/api/related-papers/paddleocr/install", {
                         method: "POST",
                         headers: { "Content-Type": "application/json" },
                         body: JSON.stringify({ pythonPath }),
                    });

                    if (!res.ok) {
                         const err = await res.json().catch(() => ({ error: "Installation failed" }));
                         const msg = (err as { error?: string }).error ?? "Installation failed";
                         // CUDA/GPU not found — show as a dismissible toast, no blocking modal
                         toast.error(msg, { duration: Infinity });
                         setStatus(null);
                         return;
                    }

                    const reader = res.body?.getReader();
                    const decoder = new TextDecoder();
                    if (!reader) {
                         setErrorMessage("No response stream from server");
                         setStatus("error");
                         return;
                    }

                    let buf = "";
                    let encounteredError = false;
                    while (true) {
                         const { done, value } = await reader.read();
                         if (done) break;
                         buf += decoder.decode(value, { stream: true });
                         const parts = buf.split("\n");
                         buf = parts.pop() ?? "";
                         for (const part of parts) {
                              const trimmed = part.trim();
                              if (!trimmed) continue;
                              try {
                                   const msg = JSON.parse(trimmed) as { type: string; line?: string; message?: string };
                                   if (msg.type === "output" || msg.type === "command") {
                                        const line = msg.line ?? "";
                                        setLogLines((prev) => [...prev, line]);
                                        if (line) setLastOutputLine(line);
                                   } else if (msg.type === "error") {
                                        setErrorMessage(msg.message ?? "Unknown error");
                                        setStatus("error");
                                        encounteredError = true;
                                   } else if (msg.type === "done") {
                                        setStatus("done");
                                   }
                              } catch { /* ignore malformed lines */ }
                         }
                    }
                    if (!encounteredError) {
                         setStatus((s) => (s === "error" ? "error" : "done"));
                    }
               } catch (err) {
                    setErrorMessage(err instanceof Error ? err.message : "Installation failed");
                    setStatus("error");
               }
          };

          void run();
     }, []);

     // Auto-scroll log as lines arrive
     useEffect(() => {
          if (logScrollRef.current) {
               logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
          }
     }, [logLines]);

     if (!status) return null;

     return (
          <>
               {/* Small bottom-right card while the install is in progress */}
               {status === "running" && (
                    <div className="fixed bottom-4 right-4 z-50 w-full max-w-sm pointer-events-none">
                         <div className="w-full bg-light-primary/95 dark:bg-dark-primary/95 border border-light-200 dark:border-dark-200 rounded-xl p-4 shadow-lg backdrop-blur">
                              <div className="flex items-start justify-between gap-3">
                                   <div>
                                        <p className="text-xs text-black/50 dark:text-white/50">Background install</p>
                                        <h3 className="text-sm font-semibold text-black dark:text-white">Paddle Model</h3>
                                   </div>
                              </div>
                              <div className="flex items-center gap-2 mt-3">
                                   <Loader2 className="w-3 h-3 animate-spin text-[#F8B692] flex-shrink-0" />
                                   <p className="text-xs text-black/70 dark:text-white/70 truncate">
                                        {lastOutputLine || "Installing dependencies…"}
                                   </p>
                              </div>
                         </div>
                    </div>
               )}

               {/* Centered success modal */}
               {status === "done" && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                         <div className="w-[90vw] max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl shadow-2xl p-6 flex flex-col gap-4">
                              <div className="flex items-center gap-3">
                                   <div className="w-9 h-9 rounded-full bg-green-100 dark:bg-green-950/40 flex items-center justify-center flex-shrink-0">
                                        <Check className="w-5 h-5 text-green-600 dark:text-green-400" />
                                   </div>
                                   <div>
                                        <p className="text-sm font-semibold text-black dark:text-white">Paddle Model installed</p>
                                        <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
                                             Can now process PDFs.
                                        </p>
                                   </div>
                              </div>
                              <div className="flex justify-end">
                                   <button
                                        type="button"
                                        onClick={() => setStatus(null)}
                                        className="px-4 py-2 text-sm rounded-lg bg-[#F8B692] text-black hover:bg-[#e6ad82] active:scale-95 transition-all font-medium"
                                   >
                                        Got it
                                   </button>
                              </div>
                         </div>
                    </div>
               )}

               {/* Centered error modal */}
               {status === "error" && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                         <div className="w-[90vw] max-w-lg bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl shadow-2xl p-6 flex flex-col gap-4">
                              <div className="flex items-center gap-3">
                                   <div className="w-9 h-9 rounded-full bg-red-100 dark:bg-red-950/40 flex items-center justify-center flex-shrink-0">
                                        <AlertTriangle className="w-5 h-5 text-red-600 dark:text-red-400" />
                                   </div>
                                   <div>
                                        <p className="text-sm font-semibold text-black dark:text-white">PaddleOCR installation failed</p>
                                        <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
                                             OCR features will not be available. You can retry from Settings.
                                        </p>
                                   </div>
                              </div>
                              {errorMessage && (
                                   <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-400 font-mono break-words">
                                        {errorMessage}
                                   </div>
                              )}
                              {logLines.length > 0 && (
                                   <div
                                        ref={logScrollRef}
                                        className="h-64 overflow-y-auto rounded-lg bg-black/90 p-3 font-mono text-[11px] text-green-400 space-y-0.5"
                                   >
                                        {logLines.map((line, i) => (
                                             <p key={i} className="leading-relaxed whitespace-pre-wrap break-all">{line}</p>
                                        ))}
                                   </div>
                              )}
                              <div className="flex justify-end">
                                   <button
                                        type="button"
                                        onClick={() => setStatus(null)}
                                        className="px-4 py-2 text-sm rounded-lg bg-light-200 dark:bg-dark-200 text-black dark:text-white hover:bg-light-secondary dark:hover:bg-dark-secondary active:scale-95 transition-all font-medium"
                                   >
                                        Dismiss
                                   </button>
                              </div>
                         </div>
                    </div>
               )}
          </>
     );
}
