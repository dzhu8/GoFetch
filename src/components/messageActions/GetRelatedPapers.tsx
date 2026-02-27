"use client";

import { useRef, useState, Fragment } from "react";
import { FileText, Loader2, X, AlertCircle } from "lucide-react";
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from "@headlessui/react";
import { toast } from "sonner";
import { parseReferences, extractDocumentMetadata } from "@/lib/citations/parseReferences";
import { useChat } from "@/lib/chat/Chat";
import { sendSystemNotification } from "@/lib/utils";

const GetRelatedPapers = () => {
     const fileInputRef = useRef<HTMLInputElement | null>(null);
     const [loading, setLoading] = useState(false);
     const [showProgressModal, setShowProgressModal] = useState(false);
     const [statusMessage, setStatusMessage] = useState<string | null>(null);
     const [errorMessage, setErrorMessage] = useState<string | null>(null);
     const { addRelatedPapers, chatId } = useChat();

     const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          // Reset so the same file can be re-selected after an error
          e.target.value = "";

          if (!file) return;

          if (!file.name.toLowerCase().endsWith(".pdf")) {
               setErrorMessage("Only PDF files are supported. Please select a .pdf file.");
               return;
          }

          setLoading(true);
          setShowProgressModal(true);
          setStatusMessage("Running");

          // Request notification permission upfront so the OS prompt appears
          // in context (while the user is watching) rather than after a long wait.
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
               Notification.requestPermission();
          }

          try {
               const formData = new FormData();
               formData.append("pdf", file);

               const res = await fetch("/api/related-papers/paddleocr/extract", {
                    method: "POST",
                    body: formData,
               });

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
                              if (err instanceof Error && err.message !== "OCR extraction failed") {
                                   throw err;
                              }
                              console.error("Error parsing NDJSON chunk:", err);
                         }
                    }
               }

               if (!ocrResult) {
                    throw new Error("OCR produced no result");
               }

               //  Extract document metadata (Title & DOI) 
               const docMetadata = extractDocumentMetadata(ocrResult);
               let pdfTitle = docMetadata.title || file.name.replace(/\.pdf$/i, "");
               let pdfDoi = docMetadata.doi;

               // Use only first 7 words for notification title to fit comfortably
               const shortTitle = pdfTitle.split(/\s+/).slice(0, 7).join(" ") + (pdfTitle.split(/\s+/).length > 7 ? "..." : "");

               //  Parse references from the OCR output 
               setStatusMessage("Parsing citations");
               const references = parseReferences(ocrResult);

               if (references.length === 0) {
                    toast.info("No citations (reference_content blocks) found in this PDF.");
                    return;
               }

               const terms = references.map((r) => r.searchTerm);
               const isDoiFlags = references.map((r) => r.isDoi);

               //  Search for related papers 
               setStatusMessage(`Searching ${terms.length} citation terms`);

               const searchRes = await fetch("/api/related-papers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ terms, isDoiFlags, pdfTitle, pdfDoi }),
               });

               if (!searchRes.ok) {
                    const data = await searchRes.json().catch(() => ({}));
                    throw new Error(data.error || "Related papers search failed");
               }

               const searchData = await searchRes.json();

               //  Add results to chat and navigate 
               addRelatedPapers(searchData);
               window.history.replaceState(null, "", `/c/${chatId}`);
               toast.success(`Found related papers for ${references.length} citations`);
               sendSystemNotification(`PDF ${shortTitle} has been successfully uploaded.`, {
                    body: `Found ${references.length} related citation${references.length === 1 ? "" : "s"}.`,
               });
          } catch (err) {
               const msg = err instanceof Error ? err.message : "Related papers extraction failed";
               toast.error(msg);
               sendSystemNotification(`Error uploading PDF ${file.name}`, {
                    body: msg,
               });
          } finally {
               setLoading(false);
               setShowProgressModal(false);
               setStatusMessage(null);
          }
     };

     return (
          <>
               {loading ? (
                    <div className="flex items-center gap-2 w-full h-full p-2">
                         <Loader2 size={16} className="animate-spin text-[#F8B692]" />
                    </div>
               ) : (
                    <button
                         type="button"
                         onClick={() => fileInputRef.current?.click()}
                         title="Get related papers from PDF citations"
                         className="w-full h-full p-2 flex items-center justify-center transition duration-200"
                    >
                         <input type="file" accept=".pdf" onChange={handleChange} ref={fileInputRef} hidden />
                         <FileText size={16} className="text-[#F8B692]" />
                    </button>
               )}

               {/* Processing / Long Task Modal */}
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
                                                            {statusMessage || "Processing PDF..."}
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
