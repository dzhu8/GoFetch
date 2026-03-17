"use client";

import { useState } from "react";
import { usePdfParseActions, usePdfParseJobs, PdfParseJob } from "./PdfParseProvider";
import { FileText, Loader2, CheckCircle2, AlertCircle, X, ChevronDown, Ban, CopyCheck, FolderSymlink } from "lucide-react";

const MAX_VISIBLE = 5;

function getStatusIcon(status: PdfParseJob["status"]) {
     switch (status) {
          case "uploading":
          case "processing":
               return <Loader2 className="w-4 h-4 animate-spin text-[#F8B692]" />;
          case "complete":
               return <CheckCircle2 className="w-4 h-4 text-green-500" />;
          case "duplicate":
               return <FolderSymlink className="w-4 h-4 text-blue-500" />;
          case "duplicate_same_folder":
               return <CopyCheck className="w-4 h-4 text-amber-500" />;
          case "error":
               return <AlertCircle className="w-4 h-4 text-red-500" />;
          default:
               return null;
     }
}

function getLabel(status: PdfParseJob["status"]) {
     switch (status) {
          case "uploading":
               return "Uploading";
          case "processing":
               return "Running OCR";
          case "complete":
               return "Complete";
          case "duplicate":
               return "Already Processed";
          case "duplicate_same_folder":
               return "Already in Folder";
          case "error":
               return "Error";
          default:
               return "";
     }
}

export default function PdfParseToasts() {
     const jobs = usePdfParseJobs();
     const { dismissJob, cancelJob } = usePdfParseActions();
     const [queueExpanded, setQueueExpanded] = useState(false);

     const activeJobs = jobs
          .filter((j) => j.status !== "queued")
          .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
          .slice(0, MAX_VISIBLE);

     // Queued jobs in submission order (oldest first = next up first)
     const queuedJobs = jobs.filter((j) => j.status === "queued");

     if (activeJobs.length === 0 && queuedJobs.length === 0) return null;

     return (
          <div className="fixed bottom-20 right-4 z-50 flex flex-col items-end gap-3 w-full max-w-sm pointer-events-none">
               {/* Active / complete / error job toasts */}
               {activeJobs.map((job) => (
                    <div
                         key={job.id}
                         className="pointer-events-auto w-full bg-light-primary/95 dark:bg-dark-primary/95 border border-light-200 dark:border-dark-200 rounded-xl p-4 shadow-lg backdrop-blur animate-in slide-in-from-right-5 fade-in duration-300"
                    >
                         <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                   {getStatusIcon(job.status)}
                                   <div className="min-w-0">
                                        <p className="text-[10px] uppercase tracking-wide text-black/50 dark:text-white/50">
                                             {getLabel(job.status)}
                                        </p>
                                        <p className="text-sm font-semibold text-black dark:text-white truncate" title={job.fileName}>
                                             {job.fileName.length > 30 ? job.fileName.slice(0, 27) + "..." : job.fileName}
                                        </p>
                                   </div>
                              </div>
                              <button
                                   type="button"
                                   onClick={() => dismissJob(job.id)}
                                   className="flex-shrink-0 p-1 rounded hover:bg-light-200 dark:hover:bg-dark-200 text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white transition-colors"
                                   aria-label="Dismiss"
                              >
                                   <X size={14} />
                              </button>
                         </div>

                         <p className="mt-2 text-xs text-black/60 dark:text-white/60 truncate" title={job.message}>
                              {job.message}
                         </p>

                         {/* Duplicate detail: show previous folder and title */}
                         {job.status === "duplicate" && job.duplicateFolderName && (
                              <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 px-2.5 py-1.5">
                                   <FolderSymlink size={11} className="mt-0.5 shrink-0 text-blue-500" />
                                   <p className="text-[11px] text-blue-600 dark:text-blue-400 leading-snug">
                                        Previously in{" "}
                                        <span className="font-semibold">&ldquo;{job.duplicateFolderName}&rdquo;</span>
                                        {job.duplicateTitle && (
                                             <> &mdash; <span className="italic">{job.duplicateTitle.length > 60 ? job.duplicateTitle.slice(0, 57) + "…" : job.duplicateTitle}</span></>
                                        )}
                                   </p>
                              </div>
                         )}

                         {job.status === "duplicate_same_folder" && (
                              <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5">
                                   <CopyCheck size={11} className="mt-0.5 shrink-0 text-amber-500" />
                                   <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                                        This paper is already in this folder. No changes were made.
                                   </p>
                              </div>
                         )}

                         <div className="mt-2 flex items-center justify-between">
                              <p className="text-[10px] text-black/40 dark:text-white/40">
                                   Folder: {job.folderName}
                              </p>
                              {(job.status === "uploading" || job.status === "processing") && (
                                   <button
                                        type="button"
                                        onClick={() => cancelJob(job.id)}
                                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-red-500/80 hover:text-red-500 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40 transition-colors"
                                        aria-label="Cancel OCR"
                                   >
                                        <Ban size={10} />
                                        Cancel
                                   </button>
                              )}
                         </div>
                    </div>
               ))}

               {/* Queue accordion */}
               {queuedJobs.length > 0 && (
                    <div className="pointer-events-auto w-full bg-light-primary/95 dark:bg-dark-primary/95 border border-light-200 dark:border-dark-200 rounded-xl shadow-lg backdrop-blur overflow-hidden animate-in slide-in-from-right-5 fade-in duration-300">
                         <button
                              type="button"
                              onClick={() => setQueueExpanded((v) => !v)}
                              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-black/70 dark:text-white/70 hover:bg-light-200/40 dark:hover:bg-dark-200/40 transition-colors"
                         >
                              <span>
                                   {queuedJobs.length} file{queuedJobs.length !== 1 ? "s" : ""} in queue
                              </span>
                              <ChevronDown
                                   size={15}
                                   className={`transition-transform duration-200 text-black/40 dark:text-white/40 ${
                                        queueExpanded ? "rotate-180" : ""
                                   }`}
                              />
                         </button>

                         {queueExpanded && (
                              <div className="border-t border-light-200 dark:border-dark-200 px-4 py-2 flex flex-col gap-1">
                                   {queuedJobs.map((job, i) => (
                                        <div
                                             key={job.id}
                                             className="flex items-center gap-2 py-1.5"
                                        >
                                             <span className="text-[10px] font-mono text-black/30 dark:text-white/30 w-4 shrink-0">
                                                  {i + 1}
                                             </span>
                                             <FileText size={12} className="shrink-0 text-black/40 dark:text-white/40" />
                                             <span
                                                  className="text-xs text-black/70 dark:text-white/70 truncate"
                                                  title={job.fileName}
                                             >
                                                  {job.fileName}
                                             </span>
                                             <span className="text-[10px] text-black/30 dark:text-white/30 shrink-0 ml-auto">
                                                  {job.folderName}
                                             </span>
                                             <button
                                                  type="button"
                                                  onClick={() => dismissJob(job.id)}
                                                  className="shrink-0 p-0.5 rounded hover:bg-light-200 dark:hover:bg-dark-200 text-black/30 dark:text-white/30 hover:text-black dark:hover:text-white transition-colors"
                                                  aria-label="Remove from queue"
                                             >
                                                  <X size={11} />
                                             </button>
                                        </div>
                                   ))}
                              </div>
                         )}
                    </div>
               )}
          </div>
     );
}
