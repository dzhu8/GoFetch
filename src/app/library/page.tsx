"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Fragment } from "react";
import {
     AlertCircle,
     FolderOpen,
     FolderPlus,
     FileText,
     Loader2,
     Plus,
     Trash2,
     Upload,
} from "lucide-react";
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from "@headlessui/react";
import GoFetchDogBox from "@/assets/GoFetch-dog-box.svg";
import { sendSystemNotification } from "@/lib/utils";

interface FolderData {
     id: number;
     name: string;
     rootPath: string;
}

export default function LibraryPage() {
     const router = useRouter();
     const [folders, setFolders] = useState<FolderData[]>([]);
     const [paperCounts, setPaperCounts] = useState<Map<number, number>>(new Map());
     const [isLoading, setIsLoading] = useState(true);
     const [deletingId, setDeletingId] = useState<number | null>(null);
     const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
     const [uploadingFolderId, setUploadingFolderId] = useState<number | null>(null);
     const [showProgressModal, setShowProgressModal] = useState(false);
     const [uploadStatus, setUploadStatus] = useState<string>("Uploading...");
     const [errorModal, setErrorModal] = useState<string | null>(null);
     const fileInputRefs = useRef<Map<number, HTMLInputElement>>(new Map());

     const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
     const [isPromptingFolder, setIsPromptingFolder] = useState(false);
     const [newFolderName, setNewFolderName] = useState("");
     const [isSavingFolder, setIsSavingFolder] = useState(false);
     const [libraryRoot, setLibraryRoot] = useState<string | null>(null);

     const fetchFolders = async () => {
          try {
               setIsLoading(true);
               const res = await fetch("/api/library-folders");
               if (!res.ok) throw new Error("Failed to fetch folders");
               const data = await res.json();
               setFolders(data.folders || []);
               if (data.libraryRoot) setLibraryRoot(data.libraryRoot);

               // Fetch paper counts for each folder
               const counts = new Map<number, number>();
               await Promise.all(
                    (data.folders || []).map(async (folder: FolderData) => {
                         try {
                              const papersRes = await fetch(`/api/papers?folderId=${folder.id}`);
                              if (papersRes.ok) {
                                   const papersData = await papersRes.json();
                                   counts.set(folder.id, papersData.papers?.length || 0);
                              }
                         } catch {}
                    })
               );
               setPaperCounts(counts);
          } catch (error) {
               console.error("Error fetching folders:", error);
          } finally {
               setIsLoading(false);
          }
     };

     // "Create Folder": user types a name → creates data/library/[name]
     const handleCreateFolder = async () => {
          const trimmedName = newFolderName.trim();
          if (!trimmedName) {
               setErrorModal("Folder name is required.");
               return;
          }
          setIsSavingFolder(true);
          try {
               const res = await fetch("/api/library-folders", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: trimmedName }),
               });
               if (!res.ok) {
                    const err = await res.json().catch(() => ({ error: "Failed to create folder" }));
                    throw new Error(err.error || "Failed to create folder");
               }
               setIsCreateModalOpen(false);
               setNewFolderName("");
               await fetchFolders();
          } catch (error) {
               console.error("Error creating folder:", error);
               setErrorModal(error instanceof Error ? error.message : "Failed to create folder");
          } finally {
               setIsSavingFolder(false);
          }
     };

     // "Add Folder": CLI picker → extracts basename → creates data/library/[basename]
     const handleAddFolderClick = async () => {
          setIsPromptingFolder(true);
          try {
               const res = await fetch("/api/cli/folder-selection", { method: "POST", cache: "no-store" });
               const data = await res.json().catch(() => null);
               if (!res.ok) {
                    throw new Error(data?.error || "Unable to open the native folder picker. Is the GoFetch CLI running?");
               }
               if (data?.status === "cancelled") return;
               const selection = data?.selection;
               if (!selection?.path) {
                    throw new Error("No folder was selected.");
               }
               const derivedName =
                    selection.name?.trim() ||
                    selection.path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ||
                    "";
               if (!derivedName) {
                    throw new Error("Could not determine folder name from the selected path.");
               }
               const postRes = await fetch("/api/library-folders", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: derivedName }),
               });
               const postData = await postRes.json().catch(() => ({}));
               if (!postRes.ok) throw new Error(postData.error || "Failed to add folder");
               await fetchFolders();
          } catch (error) {
               console.error("Error adding folder:", error);
               setErrorModal(error instanceof Error ? error.message : "Failed to add folder");
          } finally {
               setIsPromptingFolder(false);
          }
     };

     const handleDelete = async (folderId: number) => {
          setDeletingId(folderId);
          try {
               const res = await fetch(`/api/library-folders/${folderId}`, {
                    method: "DELETE",
               });
               if (!res.ok) throw new Error("Failed to delete folder");
               setFolders((prev) => prev.filter((f) => f.id !== folderId));
               setPaperCounts((prev) => {
                    const next = new Map(prev);
                    next.delete(folderId);
                    return next;
               });
          } catch (error) {
               console.error("Error deleting folder:", error);
          } finally {
               setDeletingId(null);
               setConfirmDeleteId(null);
          }
     };

     const handleUploadClick = (folderId: number) => {
          const input = fileInputRefs.current.get(folderId);
          if (input) input.click();
     };

     const handleFileSelected = async (folderId: number, e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = "";

          if (!file.name.toLowerCase().endsWith(".pdf")) {
               setErrorModal("Please select a PDF file. Only PDF files can be uploaded to the library.");
               return;
          }

          setUploadingFolderId(folderId);
          setShowProgressModal(true);
          setUploadStatus("Uploading PDF...");

          try {
               const formData = new FormData();
               formData.append("pdf", file);
               formData.append("folderId", String(folderId));

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
               let finalPaper: any = null;

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
                                        if (event.type === "complete" && event.paper) {
                                             finalPaper = event.paper;
                                             setPaperCounts((prev) => {
                                                  const newMap = new Map(prev);
                                                  newMap.set(folderId, (newMap.get(folderId) || 0) + 1);
                                                  return newMap;
                                             });
                                        } else if (event.type === "status") {
                                             setUploadStatus(event.message);
                                        } else if (event.type === "error") {
                                             console.error("Upload error:", event.message);
                                             throw new Error(event.message || "Upload failed");
                                        }
                                   } catch (e) {
                                        if (e instanceof Error) throw e;
                                   }
                              }
                         }
                    }
               }

               if (finalPaper) {
                    const titleWords = (finalPaper.title || file.name).split(/\s+/);
                    const shortTitle = titleWords.slice(0, 7).join(" ") + (titleWords.length > 7 ? "..." : "");
                    sendSystemNotification(`PDF ${shortTitle} has been successfully uploaded.`, {
                         body: `Added to folder: ${folders.find(f => f.id === folderId)?.name || "Library"}`,
                         icon: "/icon.png"
                    });
               }
          } catch (error) {
               const errorMsg = error instanceof Error ? error.message : "Upload failed";
               console.error("Error uploading paper:", error);
               setErrorModal(errorMsg);

               sendSystemNotification(`Error uploading PDF ${file.name}`, {
                    body: errorMsg,
               });
          } finally {
               setUploadingFolderId(null);
               setShowProgressModal(false);
          }
     };

     useEffect(() => {
          fetchFolders();
     }, []);

     const folderForDelete = folders.find((f) => f.id === confirmDeleteId);

     return (
          <div className="h-full flex flex-col">
               {/* Progress Modal */}
               <Transition appear show={showProgressModal} as={Fragment}>
                    <Dialog as="div" className="relative z-50" onClose={() => setShowProgressModal(false)}>
                         <TransitionChild
                              as={Fragment}
                              enter="ease-out duration-300"
                              enterFrom="opacity-0"
                              enterTo="opacity-100"
                              leave="ease-in duration-200"
                              leaveFrom="opacity-100"
                              leaveTo="opacity-0"
                         >
                              <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
                         </TransitionChild>

                         <div className="fixed inset-0 overflow-y-auto">
                              <div className="flex min-h-full items-center justify-center p-4">
                                   <TransitionChild
                                        as={Fragment}
                                        enter="ease-out duration-300"
                                        enterFrom="opacity-0 scale-95"
                                        enterTo="opacity-100 scale-100"
                                        leave="ease-in duration-200"
                                        leaveFrom="opacity-100 scale-100"
                                        leaveTo="opacity-0 scale-95"
                                   >
                                        <DialogPanel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 p-6 shadow-2xl transition-all">
                                             <DialogTitle as="h3" className="text-lg font-semibold text-black dark:text-white flex items-center gap-2">
                                                  <Upload className="w-5 h-5 text-[#F8B692]" />
                                                  Uploading Paper
                                             </DialogTitle>
                                             <div className="mt-4 space-y-4">
                                                  <p className="text-sm text-black/60 dark:text-white/60">
                                                       Your PDF is being uploaded and indexed. This <strong>may take a long time</strong> for larger documents.
                                                  </p>
                                                  <p className="text-sm text-[#F8B692] font-medium p-3 bg-[#F8B692]/10 rounded-lg border border-[#F8B692]/20">
                                                       Feel free to keep browsing your library! We'll send you a system notification once the indexing is complete.
                                                  </p>
                                                  <div className="flex items-center gap-3 pt-4 border-t border-light-200 dark:border-dark-200">
                                                       <Loader2 className="w-5 h-5 animate-spin text-[#F8B692]" />
                                                       <span className="text-sm font-mono text-black/70 dark:text-white/70">
                                                            {uploadStatus}
                                                       </span>
                                                  </div>
                                             </div>
                                             <div className="mt-8 flex justify-end">
                                                  <button
                                                       type="button"
                                                       className="px-4 py-2 text-sm font-medium text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60 rounded-lg border border-light-200 dark:border-dark-200 transition-colors"
                                                       onClick={() => setShowProgressModal(false)}
                                                  >
                                                       Background this
                                                  </button>
                                             </div>
                                        </DialogPanel>
                                   </TransitionChild>
                              </div>
                         </div>
                    </Dialog>
               </Transition>

               {/* Header Section */}
               <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-6">
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
                                   Library
                              </h1>
                              <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                                   Manage your paper collections by folder
                              </p>
                         </div>
                    </div>
                    <div className="flex flex-col items-center gap-2">
                         <div className="flex items-center gap-3">
                              <button
                                   type="button"
                                   onClick={handleAddFolderClick}
                                   disabled={isPromptingFolder}
                                   className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black font-medium text-sm hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                   {isPromptingFolder ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                   ) : (
                                        <Plus className="w-4 h-4" />
                                   )}
                                   {isPromptingFolder ? "Opening..." : "Add Folder"}
                              </button>
                              <button
                                   type="button"
                                   onClick={() => {
                                        setNewFolderName("");
                                        setIsCreateModalOpen(true);
                                   }}
                                   className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border-2 border-[#F8B692] text-[#F8B692] font-medium text-sm hover:bg-[#F8B692]/10 active:scale-95 transition-all duration-200"
                              >
                                   <FolderPlus className="w-4 h-4" />
                                   Create Folder
                              </button>
                         </div>
                         {libraryRoot && (
                              <p className="text-xs text-black/40 dark:text-white/40">
                                   Library: <span className="font-mono">{libraryRoot}</span>
                              </p>
                         )}
                    </div>
               </div>

               {/* Folders List Section */}
               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    {isLoading ? (
                         <div className="flex flex-col items-center justify-center py-12">
                              <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                              <p className="text-sm text-black/60 dark:text-white/60">Loading folders...</p>
                         </div>
                    ) : folders.length === 0 ? (
                         <div className="flex flex-col items-center justify-center py-12 text-center">
                              <FolderOpen className="w-12 h-12 text-black/20 dark:text-white/20 mb-3" />
                              <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                   No folders yet
                              </p>
                              <p className="text-sm text-black/50 dark:text-white/50">
                                   Add an existing folder or create a new one to start collecting papers
                              </p>
                         </div>
                    ) : (
                         <div className="flex flex-col gap-3 max-w-4xl mx-auto w-full">
                              {folders.map((folder) => (
                                   <div
                                        key={folder.id}
                                        onClick={() => router.push(`/library/${folder.id}`)}
                                        className="relative bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow duration-200 cursor-pointer w-full"
                                   >
                                        <div className="flex items-start justify-between gap-3">
                                             <div className="flex-1 min-w-0">
                                                  <div className="flex items-center gap-2 mb-1">
                                                       <FolderOpen className="w-4 h-4 text-[#F8B692] flex-shrink-0" />
                                                       <h3 className="text-sm font-medium text-black dark:text-white truncate">
                                                            {folder.name}
                                                       </h3>
                                                  </div>
                                                  <p className="text-xs text-black/50 dark:text-white/50 truncate ml-6">
                                                       {folder.rootPath}
                                                  </p>
                                                  <div className="flex items-center gap-3 mt-1.5 ml-6">
                                                       <span className="text-xs text-black/40 dark:text-white/40 flex items-center gap-1">
                                                            <FileText className="w-3 h-3" />
                                                            {paperCounts.get(folder.id) || 0} papers
                                                       </span>
                                                  </div>
                                             </div>
                                             <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                                  {/* Upload button */}
                                                  <button
                                                       type="button"
                                                       onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleUploadClick(folder.id);
                                                       }}
                                                       disabled={uploadingFolderId === folder.id}
                                                       className="p-2 rounded-lg text-black/50 dark:text-white/50 hover:text-[#F8B692] hover:bg-[#F8B692]/10 transition-colors duration-200 disabled:opacity-50"
                                                       aria-label="Upload paper"
                                                  >
                                                       {uploadingFolderId === folder.id ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                       ) : (
                                                            <Upload className="w-4 h-4" />
                                                       )}
                                                  </button>
                                                  {/* Hidden file input */}
                                                  <input
                                                       type="file"
                                                       accept=".pdf,application/pdf"
                                                       className="hidden"
                                                       onClick={(e) => e.stopPropagation()}
                                                       ref={(el) => {
                                                            if (el) fileInputRefs.current.set(folder.id, el);
                                                       }}
                                                       onChange={(e) => handleFileSelected(folder.id, e)}
                                                  />
                                                  {/* Delete button */}
                                                  <button
                                                       type="button"
                                                       onClick={(e) => {
                                                            e.stopPropagation();
                                                            setConfirmDeleteId(folder.id);
                                                       }}
                                                       disabled={deletingId === folder.id}
                                                       className="p-2 rounded-lg text-black/50 dark:text-white/50 hover:text-red-500 hover:bg-red-500/10 transition-colors duration-200 disabled:opacity-50"
                                                       aria-label="Delete folder"
                                                  >
                                                       {deletingId === folder.id ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                       ) : (
                                                            <Trash2 className="w-4 h-4" />
                                                       )}
                                                  </button>
                                             </div>
                                        </div>
                                   </div>
                              ))}
                         </div>
                    )}
               </div>

               {/* Create Folder Modal */}
               {isCreateModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-4">Create Folder</h2>
                              {libraryRoot && (
                                   <p className="text-xs text-black/50 dark:text-white/50 mb-4 font-mono break-all">
                                        {libraryRoot}/{newFolderName || "..."}
                                   </p>
                              )}
                              <div>
                                   <label className="text-xs font-medium text-black/70 dark:text-white/70">
                                        Folder Name
                                   </label>
                                   <input
                                        type="text"
                                        value={newFolderName}
                                        onChange={(e) => setNewFolderName(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); }}
                                        autoFocus
                                        className="mt-1 w-full px-3 py-2 text-sm bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-lg text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-[#F8B692]"
                                        placeholder="e.g. Neuroscience Papers"
                                   />
                              </div>
                              <div className="flex justify-end gap-3 mt-6">
                                   <button
                                        type="button"
                                        onClick={() => {
                                             setIsCreateModalOpen(false);
                                             setNewFolderName("");
                                        }}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={handleCreateFolder}
                                        disabled={isSavingFolder || !newFolderName.trim()}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-50"
                                   >
                                        {isSavingFolder ? "Creating..." : "Create Folder"}
                                   </button>
                              </div>
                         </div>
                    </div>
               )}

               {/* Delete Confirmation Modal */}
               {confirmDeleteId && folderForDelete && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg text-center">
                              <Trash2 className="w-10 h-10 text-red-500 mx-auto mb-3" />
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-2">Delete Folder?</h2>
                              <p className="text-sm text-black/60 dark:text-white/60 mb-6">
                                   This will remove <strong>{folderForDelete.name}</strong> and all its papers from the
                                   library. This action cannot be undone.
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
                                        onClick={() => handleDelete(folderForDelete.id)}
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
