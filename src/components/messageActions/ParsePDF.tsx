import { cn } from "@/lib/utils";
import { LoaderCircle, Paperclip, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { usePdfParseActions } from "@/components/progress/PdfParseProvider";
import { getLibraryFolders, createLibraryFolder } from "@/lib/actions/library";

interface LibraryFolder {
     id: number;
     name: string;
     rootPath: string;
}

const ParsePDF = () => {
     const fileInputRef = useRef<HTMLInputElement | null>(null);
     const { startParseJob } = usePdfParseActions();

     // Portal root — escapes the opacity-0 / overflow-hidden stacking context in ChatToolDropdown
     const [portalRoot, setPortalRoot] = useState<Element | null>(null);
     useEffect(() => {
          setPortalRoot(document.body);
     }, []);

     // Folder modal state
     const [showFolderModal, setShowFolderModal] = useState(false);
     const [folders, setFolders] = useState<LibraryFolder[]>([]);
     const [loadingFolders, setLoadingFolders] = useState(false);
     const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
     const [newFolderName, setNewFolderName] = useState("");
     const [isSavingFolder, setIsSavingFolder] = useState(false);
     const [createMode, setCreateMode] = useState(false);

     // Inline error shown inside the create-folder form
     const [folderCreateError, setFolderCreateError] = useState("");

     // "This might take a long time" confirmation modal
     const [showConfirmModal, setShowConfirmModal] = useState(false);
     const pendingFileRef = useRef<File | null>(null);
     const pendingFolderRef = useRef<{ id: number; name: string } | null>(null);

     const fetchFolders = useCallback(async (): Promise<LibraryFolder[]> => {
          setLoadingFolders(true);
          try {
               const data = await getLibraryFolders();
               if ("error" in data) throw new Error(data.error);
               const fetched: LibraryFolder[] = data.folders ?? [];
               setFolders(fetched);
               return fetched;
          } catch {
               toast.error("Failed to load library folders.");
               return [];
          } finally {
               setLoadingFolders(false);
          }
     }, []);

     // Fetch library folders once on mount
     useEffect(() => {
          fetchFolders();
     }, [fetchFolders]);

     const openFilePicker = () => fileInputRef.current?.click();

     /** Always opens the folder picker modal first. */
     const handleTriggerClick = () => {
          setSelectedFolderId(null);
          setCreateMode(false);
          setNewFolderName("");
          setShowFolderModal(true);
     };

     /** Resolves the folder (creating if needed), stores metadata, then opens the file picker. */
     const handleFolderConfirm = async () => {
          let resolvedId: number | null = null;
          let resolvedName = "";

          if (createMode) {
               const trimmed = newFolderName.trim();
               if (!trimmed) {
                    setFolderCreateError("Please enter a folder name.");
                    return;
               }
               // Client-side duplicate check (case-insensitive)
               if (folders.some((f) => f.name.toLowerCase() === trimmed.toLowerCase())) {
                    setFolderCreateError(`A folder named "${trimmed}" already exists.`);
                    return;
               }
               setIsSavingFolder(true);
               try {
                    const data = await createLibraryFolder(trimmed);
                    if ("error" in data) {
                         setFolderCreateError(data.error || "Failed to create folder.");
                         setIsSavingFolder(false);
                         return;
                    }
                    resolvedId = data.folder.id;
                    resolvedName = data.folder.name;
                    setFolders((prev) => [...prev, data.folder]);
               } catch (err: any) {
                    setFolderCreateError(err.message ?? "Failed to create folder.");
                    setIsSavingFolder(false);
                    return;
               }
               setIsSavingFolder(false);
          } else {
               if (!selectedFolderId) {
                    toast.error("Please select or create a folder.");
                    return;
               }
               resolvedId = selectedFolderId;
               resolvedName = folders.find((f) => f.id === selectedFolderId)?.name ?? "";
          }

          pendingFolderRef.current = { id: resolvedId!, name: resolvedName };
          setFolderCreateError("");
          setShowFolderModal(false);
          setNewFolderName("");
          setCreateMode(false);
          setSelectedFolderId(null);
          setTimeout(openFilePicker, 0);
     };

     /** After a file is chosen, show the "might take a long time" confirmation. */
     const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = "";

          if (!file.name.toLowerCase().endsWith(".pdf")) {
               toast.error("Only PDF files are accepted.");
               return;
          }

          if (!pendingFolderRef.current) {
               toast.error("No folder selected. Please try again.");
               return;
          }

          pendingFileRef.current = file;
          setShowConfirmModal(true);
     };

     /** User clicks "Background this" or "Start" — hands off to the provider. */
     const confirmAndStart = () => {
          const file = pendingFileRef.current;
          const folder = pendingFolderRef.current;
          if (!file || !folder) return;

          startParseJob(file, folder.id, folder.name);
          pendingFileRef.current = null;
          pendingFolderRef.current = null;
          setShowConfirmModal(false);
     };

     return (
          <>
               {/* Hidden file input — only PDFs */}
               <input
                    type="file"
                    onChange={handleFileSelected}
                    ref={fileInputRef}
                    accept=".pdf"
                    hidden
               />

               {/* ── Folder picker modal ── */}
               {showFolderModal && portalRoot && createPortal(
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-1">
                                   Choose a Library Folder
                              </h2>
                              <p className="text-xs text-black/50 dark:text-white/50 mb-4">
                                   Select a destination folder for this upload, or create a new one.
                              </p>

                              {loadingFolders ? (
                                   <div className="flex justify-center py-6">
                                        <LoaderCircle size={20} className="animate-spin text-[#F8B692]" />
                                   </div>
                              ) : createMode ? (
                                   <div>
                                        <label className="text-xs font-medium text-black/70 dark:text-white/70">
                                             New Folder Name
                                        </label>
                                        <input
                                             type="text"
                                             value={newFolderName}
                                             onChange={(e) => {
                                                  setNewFolderName(e.target.value);
                                                  if (folderCreateError) setFolderCreateError("");
                                             }}
                                             onKeyDown={(e) => {
                                                  if (e.key === "Enter") handleFolderConfirm();
                                             }}
                                             autoFocus
                                             className={cn(
                                                  "mt-1 w-full px-3 py-2 text-sm bg-light-secondary dark:bg-dark-secondary border rounded-lg text-black dark:text-white focus:outline-none focus:ring-2",
                                                  folderCreateError
                                                       ? "border-red-400 focus:ring-red-400"
                                                       : "border-light-200 dark:border-dark-200 focus:ring-[#F8B692]"
                                             )}
                                             placeholder="e.g. My Papers"
                                        />
                                        {folderCreateError && (
                                             <p className="mt-1.5 text-xs text-red-500">{folderCreateError}</p>
                                        )}
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
                                                                 : "border-light-200 dark:border-dark-200 text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60",
                                                       )}
                                                  >
                                                       {folder.name}
                                                  </button>
                                             ))
                                        )}
                                        <button
                                             type="button"
                                             onClick={() => {
                                                  setCreateMode(true);
                                                  setSelectedFolderId(null);
                                             }}
                                             className="text-left px-3 py-2 rounded-lg text-sm text-[#F8B692] border border-dashed border-[#F8B692]/50 hover:bg-[#F8B692]/10 transition-all duration-150 mt-1"
                                        >
                                             + Create new folder
                                        </button>
                                   </div>
                              )}

                              <div className="flex justify-end gap-3 mt-6">
                                   <button
                                        type="button"
                                        onClick={() => {
                                             setShowFolderModal(false);
                                             setCreateMode(false);
                                             setNewFolderName("");
                                             setSelectedFolderId(null);
                                        }}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={handleFolderConfirm}
                                        disabled={
                                             isSavingFolder ||
                                             (!createMode && !selectedFolderId) ||
                                             (createMode && !newFolderName.trim())
                                        }
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-50"
                                   >
                                        {isSavingFolder ? "Creating..." : "Continue"}
                                   </button>
                              </div>
                         </div>
                    </div>,
                    portalRoot
               )}

               {/* ── "This might take a long time" confirmation modal ── */}
               {showConfirmModal && portalRoot && createPortal(
                    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-2xl">
                              <h3 className="text-lg font-semibold text-black dark:text-white flex items-center gap-2">
                                   <Upload className="w-5 h-5 text-[#F8B692]" />
                                   Uploading Paper
                              </h3>
                              <div className="mt-4 space-y-4">
                                   <p className="text-sm text-black/60 dark:text-white/60">
                                        We&apos;ll upload <strong>{pendingFileRef.current?.name}</strong> and index it. This <strong>may take a long time</strong> depending on the document length.
                                   </p>
                                   <p className="text-sm text-[#F8B692] font-medium p-3 bg-[#F8B692]/10 rounded-lg border border-[#F8B692]/20">
                                        Feel free to explore your library or start a chat! Progress will appear in the bottom-right corner and we&apos;ll notify you when it&apos;s ready.
                                   </p>
                              </div>
                              <div className="mt-6 flex justify-end gap-3">
                                   <button
                                        type="button"
                                        onClick={() => {
                                             pendingFileRef.current = null;
                                             pendingFolderRef.current = null;
                                             setShowConfirmModal(false);
                                        }}
                                        className="px-4 py-2 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60 rounded-lg border border-light-200 dark:border-dark-200 transition-colors"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={confirmAndStart}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all duration-200"
                                   >
                                        Start &amp; Background
                                   </button>
                              </div>
                         </div>
                    </div>,
                    portalRoot
               )}

               {/* Trigger button */}
               <button
                    type="button"
                    onClick={handleTriggerClick}
                    className="w-full h-full p-2 rounded-lg text-black/50 dark:text-white/50 transition duration-200"
               >
                    <Paperclip size={16} />
               </button>
          </>
     );
};

export default ParsePDF;
