"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import {
     ArrowLeft,
     AlertCircle,
     Check,
     ClipboardCopy,
     FileText,
     Loader2,
     Trash2,
     Upload,
     X,
} from "lucide-react";
import GoFetchDogBox from "@/assets/GoFetch-dog-box.svg";

interface Paper {
     id: number;
     folderId: number;
     fileName: string;
     filePath: string;
     title: string | null;
     doi: string | null;
     abstract: string | null;
     semanticScholarId: string | null;
     semanticScholarCitation: string | null;
     firstFigurePath: string | null;
     status: "uploading" | "processing" | "ready" | "error";
     createdAt: string;
     updatedAt: string;
}

interface FolderData {
     id: number;
     name: string;
     rootPath: string;
}

export default function FolderDetailPage() {
     const params = useParams();
     const router = useRouter();
     const folderId = params.folderId as string;

     const [folder, setFolder] = useState<FolderData | null>(null);
     const [papers, setPapers] = useState<Paper[]>([]);
     const [isLoading, setIsLoading] = useState(true);
     const [uploadingCount, setUploadingCount] = useState(0);
     const [errorModal, setErrorModal] = useState<string | null>(null);
     const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
     const [deletingId, setDeletingId] = useState<number | null>(null);
     const [viewingPaperId, setViewingPaperId] = useState<number | null>(null);
     const [copiedId, setCopiedId] = useState<number | null>(null);
     const fileInputRef = useRef<HTMLInputElement>(null);

     const fetchPapers = useCallback(async () => {
          try {
               setIsLoading(true);

               // Fetch folder info from library-folders API
               const folderRes = await fetch(`/api/library-folders/${folderId}`);
               if (folderRes.ok) {
                    const folderData = await folderRes.json();
                    if (folderData.folder) setFolder(folderData.folder);
               }

               // Fetch papers
               const res = await fetch(`/api/papers?folderId=${folderId}`);
               if (!res.ok) throw new Error("Failed to fetch papers");
               const data = await res.json();
               setPapers(data.papers || []);
          } catch (error) {
               console.error("Error fetching papers:", error);
          } finally {
               setIsLoading(false);
          }
     }, [folderId]);

     const handleUploadClick = () => {
          fileInputRef.current?.click();
     };

     const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = "";

          if (!file.name.toLowerCase().endsWith(".pdf")) {
               setErrorModal("Please select a PDF file. Only PDF files can be uploaded to the library.");
               return;
          }

          // Add a temporary "uploading" paper
          const tempId = -Date.now();
          const tempPaper: Paper = {
               id: tempId,
               folderId: parseInt(folderId, 10),
               fileName: file.name,
               filePath: "",
               title: file.name.replace(/\.pdf$/i, ""),
               doi: null,
               abstract: null,
               semanticScholarId: null,
               semanticScholarCitation: null,
               firstFigurePath: null,
               status: "uploading",
               createdAt: new Date().toISOString(),
               updatedAt: new Date().toISOString(),
          };
          setPapers((prev) => [...prev, tempPaper]);
          setUploadingCount((c) => c + 1);

          try {
               const formData = new FormData();
               formData.append("pdf", file);
               formData.append("folderId", folderId);

               const res = await fetch("/api/papers/upload", {
                    method: "POST",
                    body: formData,
               });

               if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.error || "Upload failed");
               }

               const reader = res.body?.getReader();
               const decoder = new TextDecoder();
               let realPaperId: number | null = null;

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
                                        if (event.type === "created") {
                                             realPaperId = event.paperId;
                                             // Replace temp paper with real ID, keep uploading status
                                             setPapers((prev) =>
                                                  prev.map((p) =>
                                                       p.id === tempId
                                                            ? { ...p, id: realPaperId!, status: "processing" }
                                                            : p
                                                  )
                                             );
                                        } else if (event.type === "complete" && event.paper) {
                                             const pid = realPaperId || tempId;
                                             setPapers((prev) =>
                                                  prev.map((p) =>
                                                       p.id === pid
                                                            ? {
                                                                   ...p,
                                                                   ...event.paper,
                                                                   id: event.paper.id || pid,
                                                              }
                                                            : p
                                                  )
                                             );
                                        } else if (event.type === "error") {
                                             const pid = realPaperId || tempId;
                                             setPapers((prev) =>
                                                  prev.map((p) =>
                                                       p.id === pid ? { ...p, status: "error" } : p
                                                  )
                                             );
                                        }
                                   } catch {}
                              }
                         }
                    }
               }
          } catch (error) {
               console.error("Error uploading paper:", error);
               // Remove temp paper on complete failure
               setPapers((prev) => prev.filter((p) => p.id !== tempId));
               setErrorModal(error instanceof Error ? error.message : "Upload failed");
          } finally {
               setUploadingCount((c) => Math.max(0, c - 1));
          }
     };

     const handleDelete = async (paperId: number) => {
          setDeletingId(paperId);
          try {
               const res = await fetch(`/api/papers/${paperId}`, { method: "DELETE" });
               if (!res.ok) throw new Error("Failed to delete paper");
               setPapers((prev) => prev.filter((p) => p.id !== paperId));
          } catch (error) {
               console.error("Error deleting paper:", error);
          } finally {
               setDeletingId(null);
               setConfirmDeleteId(null);
          }
     };

     const handleCopyCitation = async (paper: Paper) => {
          if (!paper.semanticScholarCitation) return;
          try {
               await navigator.clipboard.writeText(paper.semanticScholarCitation);
               setCopiedId(paper.id);
               setTimeout(() => setCopiedId(null), 2000);
          } catch (error) {
               console.error("Failed to copy citation:", error);
          }
     };

     useEffect(() => {
          fetchPapers();
     }, [fetchPapers]);

     // Poll for uploading/processing papers
     useEffect(() => {
          const pending = papers.filter((p) => p.status === "uploading" || p.status === "processing");
          if (pending.length === 0) return;

          const interval = setInterval(async () => {
               try {
                    const res = await fetch(`/api/papers?folderId=${folderId}`);
                    if (res.ok) {
                         const data = await res.json();
                         const freshPapers: Paper[] = data.papers || [];
                         setPapers((prev) => {
                              const freshMap = new Map(freshPapers.map((p: Paper) => [p.id, p]));
                              return prev.map((p) => {
                                   if (p.id < 0) return p; // temp paper, keep as is
                                   const fresh = freshMap.get(p.id);
                                   return fresh || p;
                              });
                         });
                    }
               } catch {}
          }, 5000);

          return () => clearInterval(interval);
     }, [papers, folderId]);

     const viewingPaper = papers.find((p) => p.id === viewingPaperId);

     return (
          <div className="h-full flex flex-col">
               {/* Header Section */}
               <div className="h-[25vh] flex items-center justify-center px-6">
                    <div className="flex items-center gap-6">
                         <Image
                              src={GoFetchDogBox}
                              alt="GoFetch dog in box"
                              width={100}
                              height={100}
                              className="w-20 h-20 md:w-24 md:h-24 lg:w-28 lg:h-28"
                         />
                         <div className="text-center">
                              <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                                   {folder?.name || "Folder"}
                              </h1>
                              <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                                   {papers.filter((p) => p.status === "ready").length} papers
                              </p>
                         </div>
                    </div>
               </div>

               {/* Toolbar */}
               <div className="px-6 pb-4 flex items-center justify-between max-w-5xl mx-auto w-full">
                    <button
                         onClick={() => router.push("/library")}
                         className="inline-flex items-center gap-1.5 text-sm text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white transition-colors"
                    >
                         <ArrowLeft className="w-4 h-4" />
                         Back to Library
                    </button>
                    <button
                         onClick={handleUploadClick}
                         className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-white text-sm font-medium hover:bg-[#F8B692]/80 active:scale-95 transition-all duration-200"
                    >
                         <Upload className="w-4 h-4" />
                         Upload PDF
                    </button>
                    <input
                         type="file"
                         accept=".pdf,application/pdf"
                         className="hidden"
                         ref={fileInputRef}
                         onChange={handleFileSelected}
                    />
               </div>

               {/* Papers Grid */}
               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    {isLoading ? (
                         <div className="flex flex-col items-center justify-center py-12">
                              <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                              <p className="text-sm text-black/60 dark:text-white/60">Loading papers...</p>
                         </div>
                    ) : papers.length === 0 ? (
                         <div className="flex flex-col items-center justify-center py-12 text-center">
                              <FileText className="w-12 h-12 text-black/20 dark:text-white/20 mb-3" />
                              <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                   No papers yet
                              </p>
                              <p className="text-sm text-black/50 dark:text-white/50">
                                   Upload a PDF to add a paper to this folder
                              </p>
                         </div>
                    ) : (
                         <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl mx-auto w-full">
                              {papers.map((paper) => (
                                   <PaperCard
                                        key={paper.id}
                                        paper={paper}
                                        onView={() => setViewingPaperId(paper.id)}
                                        onDelete={() => setConfirmDeleteId(paper.id)}
                                        onCopyCitation={() => handleCopyCitation(paper)}
                                        isDeleting={deletingId === paper.id}
                                        isCopied={copiedId === paper.id}
                                   />
                              ))}
                         </div>
                    )}
               </div>

               {/* PDF Viewer Modal */}
               {viewingPaper && viewingPaper.status === "ready" && (
                    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
                         <div className="w-full h-full max-w-5xl max-h-[95vh] mx-4 my-4 bg-light-primary dark:bg-dark-primary rounded-2xl border border-light-200 dark:border-dark-200 shadow-2xl flex flex-col overflow-hidden">
                              {/* Viewer Header */}
                              <div className="flex items-center justify-between px-4 py-3 border-b border-light-200 dark:border-dark-200 bg-light-secondary dark:bg-dark-secondary rounded-t-2xl">
                                   <div className="min-w-0 flex-1 mr-4">
                                        <h3 className="text-sm font-medium text-black dark:text-white truncate">
                                             {viewingPaper.title || viewingPaper.fileName}
                                        </h3>
                                        {viewingPaper.doi && (
                                             <p className="text-xs text-black/40 dark:text-white/40 truncate">
                                                  DOI: {viewingPaper.doi}
                                             </p>
                                        )}
                                   </div>
                                   <button
                                        onClick={() => setViewingPaperId(null)}
                                        className="p-2 rounded-lg text-black/50 dark:text-white/50 hover:bg-light-200/60 dark:hover:bg-dark-200/60 transition-colors flex-shrink-0"
                                        aria-label="Close viewer"
                                   >
                                        <X className="w-5 h-5" />
                                   </button>
                              </div>
                              {/* PDF iFrame */}
                              <div className="flex-1 overflow-hidden">
                                   <iframe
                                        src={`/api/papers/${viewingPaper.id}/pdf`}
                                        className="w-full h-full border-0"
                                        title={viewingPaper.title || viewingPaper.fileName}
                                   />
                              </div>
                         </div>
                    </div>
               )}

               {/* Delete Confirmation Modal */}
               {confirmDeleteId && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg text-center">
                              <Trash2 className="w-10 h-10 text-red-500 mx-auto mb-3" />
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-2">Delete Paper?</h2>
                              <p className="text-sm text-black/60 dark:text-white/60 mb-6">
                                   This will permanently remove this paper and its PDF file. This action cannot be
                                   undone.
                              </p>
                              <div className="flex justify-center gap-3">
                                   <button
                                        type="button"
                                        onClick={() => setConfirmDeleteId(null)}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={() => handleDelete(confirmDeleteId)}
                                        disabled={deletingId !== null}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500 text-white text-sm font-medium hover:bg-red-600 active:scale-95 transition-all duration-200 disabled:opacity-50"
                                   >
                                        {deletingId ? (
                                             <>
                                                  <Loader2 className="w-4 h-4 animate-spin" />
                                                  Deleting...
                                             </>
                                        ) : (
                                             "Delete"
                                        )}
                                   </button>
                              </div>
                         </div>
                    </div>
               )}

               {/* Error Modal */}
               {errorModal && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg text-center">
                              <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-2">Error</h2>
                              <p className="text-sm text-black/60 dark:text-white/60 mb-6">{errorModal}</p>
                              <button
                                   type="button"
                                   onClick={() => setErrorModal(null)}
                                   className="px-4 py-2 rounded-lg bg-[#F8B692] text-white text-sm font-medium hover:bg-[#F8B692]/80 active:scale-95 transition-all duration-200"
                              >
                                   OK
                              </button>
                         </div>
                    </div>
               )}
          </div>
     );
}

// ── Paper Card Component ────────────────────────────────────────────────────

function PaperCard({
     paper,
     onView,
     onDelete,
     onCopyCitation,
     isDeleting,
     isCopied,
}: {
     paper: Paper;
     onView: () => void;
     onDelete: () => void;
     onCopyCitation: () => void;
     isDeleting: boolean;
     isCopied: boolean;
}) {
     const isUploading = paper.status === "uploading" || paper.status === "processing";

     if (isUploading) {
          return (
               <div className="rounded-3xl overflow-hidden bg-light-secondary dark:bg-dark-secondary shadow-sm shadow-light-200/10 dark:shadow-black/25 flex flex-col border border-light-200 dark:border-dark-200">
                    {/* Shimmer image placeholder */}
                    <div className="relative aspect-video overflow-hidden bg-light-200 dark:bg-dark-200">
                         <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                              <div className="relative">
                                   <div className="w-10 h-10 border-2 border-[#F8B692] border-t-transparent rounded-full animate-spin" />
                                   <FileText className="w-4 h-4 text-[#F8B692] absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                              </div>
                              <span className="text-sm font-medium text-[#F8B692] animate-pulse">
                                   Uploading...
                              </span>
                         </div>
                         {/* Animated shimmer */}
                         <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[shimmer_2s_infinite]" />
                    </div>
                    <div className="p-4">
                         <div className="h-4 w-3/4 bg-light-200 dark:bg-dark-200 rounded animate-pulse mb-2" />
                         <div className="h-3 w-full bg-light-200 dark:bg-dark-200 rounded animate-pulse mb-1" />
                         <div className="h-3 w-2/3 bg-light-200 dark:bg-dark-200 rounded animate-pulse" />
                    </div>
               </div>
          );
     }

     return (
          <div
               onClick={onView}
               className="rounded-3xl overflow-hidden bg-light-secondary dark:bg-dark-secondary shadow-sm shadow-light-200/10 dark:shadow-black/25 group flex flex-col cursor-pointer border border-light-200 dark:border-dark-200 hover:shadow-md transition-shadow duration-200"
          >
               {/* Image container */}
               <div className="relative aspect-video overflow-hidden bg-light-200 dark:bg-dark-200">
                    {paper.firstFigurePath ? (
                         <img
                              className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-300"
                              src={`/api/papers/${paper.id}/figure`}
                              alt={paper.title || paper.fileName}
                         />
                    ) : (
                         <div className="absolute inset-0 flex items-center justify-center">
                              <FileText className="w-10 h-10 text-black/15 dark:text-white/15" />
                         </div>
                    )}
               </div>

               {/* Content */}
               <div className="p-4 flex-1 flex flex-col">
                    <h3 className="font-semibold text-sm mb-2 leading-tight line-clamp-2 group-hover:text-[#F8B692] transition duration-200 text-black dark:text-white">
                         {paper.title || paper.fileName}
                    </h3>
                    {paper.abstract && (
                         <p className="text-black/60 dark:text-white/60 text-xs leading-relaxed line-clamp-3 mb-3">
                              {paper.abstract}
                         </p>
                    )}
                    {paper.doi && (
                         <p className="text-black/40 dark:text-white/40 text-[10px] font-mono truncate mb-3">
                              DOI: {paper.doi}
                         </p>
                    )}

                    {/* Action buttons */}
                    <div className="mt-auto flex items-center justify-end gap-1 pt-2 border-t border-light-200/50 dark:border-dark-200/50">
                         {paper.semanticScholarCitation && (
                              <button
                                   type="button"
                                   onClick={(e) => {
                                        e.stopPropagation();
                                        onCopyCitation();
                                   }}
                                   className="p-1.5 rounded-lg text-black/40 dark:text-white/40 hover:text-[#F8B692] hover:bg-[#F8B692]/10 transition-colors duration-200"
                                   aria-label="Copy citation"
                                   title="Copy Semantic Scholar citation"
                              >
                                   {isCopied ? (
                                        <Check className="w-3.5 h-3.5 text-green-500" />
                                   ) : (
                                        <ClipboardCopy className="w-3.5 h-3.5" />
                                   )}
                              </button>
                         )}
                         <button
                              type="button"
                              onClick={(e) => {
                                   e.stopPropagation();
                                   onDelete();
                              }}
                              disabled={isDeleting}
                              className="p-1.5 rounded-lg text-black/40 dark:text-white/40 hover:text-red-500 hover:bg-red-500/10 transition-colors duration-200 disabled:opacity-50"
                              aria-label="Delete paper"
                         >
                              {isDeleting ? (
                                   <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                   <Trash2 className="w-3.5 h-3.5" />
                              )}
                         </button>
                    </div>
               </div>
          </div>
     );
}
