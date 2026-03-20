"use client";

import { useRef, useState, useCallback, useEffect, Fragment } from "react";
import { FileText, Loader2, Link, Upload, X, ChevronRight, LoaderCircle } from "lucide-react";
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from "@headlessui/react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { extractDocumentMetadata } from "@/lib/citations/parseReferences";
import { useChat } from "@/lib/chat/Chat";
import { sendSystemNotification } from "@/lib/utils";

interface LibraryFolder {
     id: number;
     name: string;
     rootPath: string;
}

type Stage = "method" | "doi" | "folder" | null;

const GetRelatedPapers = () => {
     const fileInputRef = useRef<HTMLInputElement | null>(null);
     const [loading, setLoading] = useState(false);
     const [showProgressModal, setShowProgressModal] = useState(false);
     const [statusMessage, setStatusMessage] = useState<string | null>(null);
     const { addRelatedPapers, chatId } = useChat();

     // ── Precursor modal state ─────────────────────────────────────────────
     const [stage, setStage] = useState<Stage>(null);

     // DOI path
     const [doi, setDoi] = useState("");
     const [doiError, setDoiError] = useState("");

     // PDF path — folder picker
     const [folders, setFolders] = useState<LibraryFolder[]>([]);
     const [loadingFolders, setLoadingFolders] = useState(false);
     const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
     const [createMode, setCreateMode] = useState(false);
     const [newFolderName, setNewFolderName] = useState("");
     const [folderCreateError, setFolderCreateError] = useState("");
     const [isSavingFolder, setIsSavingFolder] = useState(false);
     const pendingFolderRef = useRef<{ id: number; name: string } | null>(null);

     // Portal for modals
     const [portalRoot, setPortalRoot] = useState<Element | null>(null);
     useEffect(() => { setPortalRoot(document.body); }, []);

     // ── Fetch library folders ─────────────────────────────────────────────
     const fetchFolders = useCallback(async () => {
          setLoadingFolders(true);
          try {
               const res = await fetch("/api/library-folders");
               if (!res.ok) throw new Error();
               const data = await res.json();
               setFolders(data.folders ?? []);
          } catch {
               toast.error("Failed to load library folders.");
          } finally {
               setLoadingFolders(false);
          }
     }, []);

     const openMethodModal = () => {
          setDoi("");
          setDoiError("");
          setSelectedFolderId(null);
          setCreateMode(false);
          setNewFolderName("");
          setFolderCreateError("");
          setStage("method");
     };

     const close = () => setStage(null);

     // ── DOI flow ──────────────────────────────────────────────────────────
     const handleDoiSubmit = async () => {
          const trimmed = doi.trim();
          if (!trimmed) { setDoiError("Please enter a DOI."); return; }
          setDoiError("");
          setStage(null);
          await runRelatedPapersSearch({ pdfDoi: trimmed });
     };

     // ── PDF + folder flow ─────────────────────────────────────────────────
     const enterFolderStage = () => {
          fetchFolders();
          setStage("folder");
     };

     const handleFolderConfirm = async () => {
          let resolvedId: number | null = null;
          let resolvedName = "";

          if (createMode) {
               const trimmed = newFolderName.trim();
               if (!trimmed) { setFolderCreateError("Please enter a folder name."); return; }
               if (folders.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) {
                    setFolderCreateError(`A folder named "${trimmed}" already exists.`);
                    return;
               }
               setIsSavingFolder(true);
               try {
                    const res = await fetch("/api/library-folders", {
                         method: "POST",
                         headers: { "Content-Type": "application/json" },
                         body: JSON.stringify({ name: trimmed }),
                    });
                    const data = await res.json();
                    if (!res.ok) { setFolderCreateError(data.error || "Failed to create folder."); return; }
                    resolvedId = data.folder.id;
                    resolvedName = data.folder.name;
                    setFolders((prev) => [...prev, data.folder]);
               } catch (err: any) {
                    setFolderCreateError(err.message ?? "Failed to create folder.");
                    return;
               } finally {
                    setIsSavingFolder(false);
               }
          } else {
               if (!selectedFolderId) { toast.error("Please select or create a folder."); return; }
               resolvedId = selectedFolderId;
               resolvedName = folders.find((f) => f.id === selectedFolderId)?.name ?? "";
          }

          pendingFolderRef.current = { id: resolvedId!, name: resolvedName };
          setStage(null);
          setSelectedFolderId(null);
          setCreateMode(false);
          setNewFolderName("");
          setTimeout(() => fileInputRef.current?.click(), 0);
     };

     const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;

          if (!file.name.toLowerCase().endsWith(".pdf")) {
               toast.error("Only PDF files are accepted.");
               return;
          }

          const folder = pendingFolderRef.current;
          if (!folder) { toast.error("No folder selected. Please try again."); return; }

          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
               Notification.requestPermission();
          }

          setLoading(true);
          setShowProgressModal(true);
          setStatusMessage("Running OCR");

          try {
               const formData = new FormData();
               formData.append("pdf", file);
               formData.append("folderId", String(folder.id));

               const res = await fetch("/api/related-papers/paddleocr/extract", { method: "POST", body: formData });
               if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || "OCR extraction failed");
               }

               const reader = res.body?.getReader();
               if (!reader) throw new Error("Could not initialize stream reader");

               const decoder = new TextDecoder();
               let buffer = "";
               let ocrResult: any = null;

               while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                         if (!line.trim()) continue;
                         try {
                              const msg = JSON.parse(line);
                              if (msg.type === "complete") {
                                   ocrResult = msg.data;
                              } else if (msg.type === "page") {
                                   setStatusMessage(`OCR: page ${msg.value}`);
                              } else if (msg.type === "total") {
                                   setStatusMessage(`OCR: processing ${msg.value} pages`);
                              } else if (msg.type === "error") {
                                   throw new Error(msg.message);
                              }
                         } catch (err) {
                              if (err instanceof Error && err.message !== "OCR extraction failed") throw err;
                              console.error("Error parsing NDJSON chunk:", err);
                         }
                    }
               }

               if (!ocrResult) throw new Error("OCR produced no result");

               const docMetadata = extractDocumentMetadata(ocrResult);
               const pdfTitle = docMetadata.title || file.name.replace(/\.pdf$/i, "");
               const pdfDoi = docMetadata.doi ?? undefined;

               await runRelatedPapersSearch({ pdfTitle, pdfDoi }, file.name);
          } catch (err) {
               const msg = err instanceof Error ? err.message : "Related papers extraction failed";
               toast.error(msg);
               sendSystemNotification(`Error uploading PDF ${file.name}`, { body: msg });
               setLoading(false);
               setShowProgressModal(false);
               setStatusMessage(null);
          }
     };

     // ── Shared related-papers search ──────────────────────────────────────
     const runRelatedPapersSearch = async (
          params: { pdfTitle?: string; pdfDoi?: string },
          fileNameForNotification?: string,
     ) => {
          const displayName = params.pdfTitle || params.pdfDoi || fileNameForNotification || "paper";
          const shortTitle = displayName.split(/\s+/).slice(0, 7).join(" ") +
               (displayName.split(/\s+/).length > 7 ? "..." : "");

          if (!loading) {
               setLoading(true);
               setShowProgressModal(true);
          }
          setStatusMessage("Searching for related papers");

          try {
               const searchRes = await fetch("/api/related-papers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(params),
               });

               if (!searchRes.ok) {
                    const data = await searchRes.json().catch(() => ({}));
                    throw new Error(data.error || "Related papers search failed");
               }

               const searchData = await searchRes.json();
               const paperCount = searchData.rankedPapers?.length ?? 0;
               addRelatedPapers(searchData);
               window.history.replaceState(null, "", `/c/${chatId}`);
               toast.success(`Found ${paperCount} related paper${paperCount === 1 ? "" : "s"}`);
               sendSystemNotification(`Related papers for "${shortTitle}"`, {
                    body: `Found ${paperCount} related paper${paperCount === 1 ? "" : "s"}.`,
               });
          } catch (err) {
               const msg = err instanceof Error ? err.message : "Related papers search failed";
               toast.error(msg);
               sendSystemNotification(`Error searching for related papers`, { body: msg });
          } finally {
               setLoading(false);
               setShowProgressModal(false);
               setStatusMessage(null);
          }
     };

     return (
          <>
               <input type="file" accept=".pdf" onChange={handleFileSelected} ref={fileInputRef} hidden />

               {loading ? (
                    <div className="flex items-center gap-2 w-full h-full p-2">
                         <Loader2 size={16} className="animate-spin text-[#F8B692]" />
                    </div>
               ) : (
                    <button
                         type="button"
                         onClick={openMethodModal}
                         title="Get related papers"
                         className="w-full h-full p-2 flex items-center justify-center transition duration-200"
                    >
                         <FileText size={16} className="text-[#F8B692]" />
                    </button>
               )}

               {/* ── Method picker modal ── */}
               {stage === "method" && portalRoot && createPortal(
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-sm bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <div className="flex items-center justify-between mb-1">
                                   <h2 className="text-lg font-semibold text-black dark:text-white">
                                        Get Related Papers
                                   </h2>
                                   <button onClick={close} className="text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white">
                                        <X size={16} />
                                   </button>
                              </div>
                              <p className="text-xs text-black/50 dark:text-white/50 mb-5">
                                   Choose how to provide the source paper.
                              </p>
                              <div className="flex flex-col gap-3">
                                   <button
                                        type="button"
                                        onClick={() => setStage("doi")}
                                        className="flex items-center gap-4 px-4 py-3 rounded-xl border border-light-200 dark:border-dark-200 hover:bg-light-200/60 dark:hover:bg-dark-200/60 text-left transition-all"
                                   >
                                        <div className="shrink-0 rounded-lg bg-[#F8B692]/10 p-2">
                                             <Link size={18} className="text-[#F8B692]" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                             <p className="text-sm font-medium text-black dark:text-white">Enter a DOI</p>
                                             <p className="text-xs text-black/50 dark:text-white/40 mt-0.5">
                                                  Does not save the PDF to library. 
                                             </p>
                                        </div>
                                        <ChevronRight size={14} className="text-black/30 dark:text-white/30 shrink-0" />
                                   </button>
                                   <button
                                        type="button"
                                        onClick={enterFolderStage}
                                        className="flex items-center gap-4 px-4 py-3 rounded-xl border border-light-200 dark:border-dark-200 hover:bg-light-200/60 dark:hover:bg-dark-200/60 text-left transition-all"
                                   >
                                        <div className="shrink-0 rounded-lg bg-[#F8B692]/10 p-2">
                                             <Upload size={18} className="text-[#F8B692]" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                             <p className="text-sm font-medium text-black dark:text-white">Upload a PDF</p>
                                             <p className="text-xs text-black/50 dark:text-white/40 mt-0.5">
                                                  Keeps the PDF and its information in your library afterwards.
                                             </p>
                                        </div>
                                        <ChevronRight size={14} className="text-black/30 dark:text-white/30 shrink-0" />
                                   </button>
                              </div>
                         </div>
                    </div>,
                    portalRoot
               )}

               {/* ── DOI input modal ── */}
               {stage === "doi" && portalRoot && createPortal(
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-sm bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <div className="flex items-center justify-between mb-1">
                                   <h2 className="text-lg font-semibold text-black dark:text-white flex items-center gap-2">
                                        <Link size={16} className="text-[#F8B692]" />
                                        Enter DOI
                                   </h2>
                                   <button onClick={close} className="text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white">
                                        <X size={16} />
                                   </button>
                              </div>
                              <p className="text-xs text-black/50 dark:text-white/50 mb-4">
                                   Paste the paper&apos;s DOI (e.g. <span className="font-mono">10.1038/s41586-023-06291-2</span>).
                              </p>
                              <input
                                   type="text"
                                   value={doi}
                                   onChange={(e) => { setDoi(e.target.value); if (doiError) setDoiError(""); }}
                                   onKeyDown={(e) => { if (e.key === "Enter") handleDoiSubmit(); }}
                                   autoFocus
                                   placeholder="10.xxxx/..."
                                   className={cn(
                                        "w-full px-3 py-2 text-sm font-mono bg-light-secondary dark:bg-dark-secondary border rounded-lg text-black dark:text-white focus:outline-none focus:ring-2",
                                        doiError
                                             ? "border-red-400 focus:ring-red-400"
                                             : "border-light-200 dark:border-dark-200 focus:ring-[#F8B692]"
                                   )}
                              />
                              {doiError && <p className="mt-1.5 text-xs text-red-500">{doiError}</p>}
                              <div className="flex justify-between items-center mt-5">
                                   <button
                                        type="button"
                                        onClick={() => setStage("method")}
                                        className="text-xs text-black/50 dark:text-white/50 hover:underline"
                                   >
                                        ← Back
                                   </button>
                                   <button
                                        type="button"
                                        onClick={handleDoiSubmit}
                                        disabled={!doi.trim()}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all disabled:opacity-50"
                                   >
                                        Find Papers
                                   </button>
                              </div>
                         </div>
                    </div>,
                    portalRoot
               )}

               {/* ── Folder picker modal (PDF path) ── */}
               {stage === "folder" && portalRoot && createPortal(
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <div className="flex items-center justify-between mb-1">
                                   <h2 className="text-lg font-semibold text-black dark:text-white flex items-center gap-2">
                                        <Upload size={16} className="text-[#F8B692]" />
                                        Choose a Library Folder
                                   </h2>
                                   <button onClick={close} className="text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white">
                                        <X size={16} />
                                   </button>
                              </div>
                              <p className="text-xs text-black/50 dark:text-white/50 mb-4">
                                   The PDF will be saved here after OCR. Select an existing folder or create a new one.
                              </p>

                              {loadingFolders ? (
                                   <div className="flex justify-center py-6">
                                        <LoaderCircle size={20} className="animate-spin text-[#F8B692]" />
                                   </div>
                              ) : createMode ? (
                                   <div>
                                        <label className="text-xs font-medium text-black/70 dark:text-white/70">New Folder Name</label>
                                        <input
                                             type="text"
                                             value={newFolderName}
                                             onChange={(e) => { setNewFolderName(e.target.value); if (folderCreateError) setFolderCreateError(""); }}
                                             onKeyDown={(e) => { if (e.key === "Enter") handleFolderConfirm(); }}
                                             autoFocus
                                             className={cn(
                                                  "mt-1 w-full px-3 py-2 text-sm bg-light-secondary dark:bg-dark-secondary border rounded-lg text-black dark:text-white focus:outline-none focus:ring-2",
                                                  folderCreateError
                                                       ? "border-red-400 focus:ring-red-400"
                                                       : "border-light-200 dark:border-dark-200 focus:ring-[#F8B692]"
                                             )}
                                             placeholder="e.g. My Papers"
                                        />
                                        {folderCreateError && <p className="mt-1.5 text-xs text-red-500">{folderCreateError}</p>}
                                        <button
                                             type="button"
                                             onClick={() => { setCreateMode(false); setFolderCreateError(""); }}
                                             className="mt-2 text-xs text-black/50 dark:text-white/50 hover:underline"
                                        >
                                             ← Back to folder list
                                        </button>
                                   </div>
                              ) : (
                                   <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                                        {folders.length === 0 ? (
                                             <p className="text-sm text-black/50 dark:text-white/50 text-center py-4">
                                                  No folders yet. Create one below.
                                             </p>
                                        ) : (
                                             folders.map((folder) => (
                                                  <button
                                                       key={folder.id}
                                                       type="button"
                                                       onClick={() => setSelectedFolderId(folder.id)}
                                                       className={cn(
                                                            "text-left px-3 py-2 rounded-lg text-sm border transition-all duration-150",
                                                            selectedFolderId === folder.id
                                                                 ? "border-[#F8B692] bg-[#F8B692]/10 text-black dark:text-white"
                                                                 : "border-light-200 dark:border-dark-200 text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                                       )}
                                                  >
                                                       {folder.name}
                                                  </button>
                                             ))
                                        )}
                                        <button
                                             type="button"
                                             onClick={() => { setCreateMode(true); setSelectedFolderId(null); }}
                                             className="text-left px-3 py-2 rounded-lg text-sm text-[#F8B692] border border-dashed border-[#F8B692]/50 hover:bg-[#F8B692]/10 transition-all duration-150 mt-1"
                                        >
                                             + Create new folder
                                        </button>
                                   </div>
                              )}

                              <div className="flex justify-between items-center mt-6">
                                   <button
                                        type="button"
                                        onClick={() => setStage("method")}
                                        className="text-xs text-black/50 dark:text-white/50 hover:underline"
                                   >
                                        ← Back
                                   </button>
                                   <button
                                        type="button"
                                        onClick={handleFolderConfirm}
                                        disabled={
                                             isSavingFolder ||
                                             (!createMode && !selectedFolderId) ||
                                             (createMode && !newFolderName.trim())
                                        }
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all disabled:opacity-50"
                                   >
                                        {isSavingFolder ? "Creating..." : "Select PDF"}
                                   </button>
                              </div>
                         </div>
                    </div>,
                    portalRoot
               )}

               {/* ── Progress modal ── */}
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
                                        <DialogPanel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white dark:bg-zinc-900 p-6 text-left align-middle shadow-xl transition-all border border-zinc-200 dark:border-zinc-800">
                                             <DialogTitle
                                                  as="h3"
                                                  className="text-lg font-semibold leading-6 text-zinc-900 dark:text-zinc-100 flex items-center gap-2"
                                             >
                                                  <FileText className="text-[#F8B692]" size={20} />
                                                  Extracting Papers
                                             </DialogTitle>
                                             <div className="mt-4 flex flex-col items-center gap-4 py-4">
                                                  <div className="relative">
                                                       <div className="absolute inset-0 animate-ping rounded-full bg-[#F8B692]/20" />
                                                       <div className="relative rounded-full bg-[#F8B692]/10 p-4">
                                                            <Loader2 size={32} className="animate-spin text-[#F8B692]" />
                                                       </div>
                                                  </div>
                                                  <div className="text-center">
                                                       <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                                            {statusMessage || "Processing..."}
                                                       </p>
                                                       <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                                                            This may take a minute for large files
                                                       </p>
                                                  </div>
                                             </div>

                                             <div className="mt-6 flex justify-end">
                                                  <button
                                                       type="button"
                                                       className="rounded-md border border-transparent bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-200 focus:outline-none dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors"
                                                       onClick={() => setShowProgressModal(false)}
                                                  >
                                                       Run in background
                                                  </button>
                                             </div>
                                        </DialogPanel>
                                   </TransitionChild>
                              </div>
                         </div>
                    </Dialog>
               </Transition>
          </>
     );
};

export default GetRelatedPapers;

