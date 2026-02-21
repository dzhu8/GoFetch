"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogPanel, DialogTitle, Description } from "@headlessui/react";
import { AnimatePresence, motion } from "framer-motion";

const GetRelatedPapers = () => {
     const fileInputRef = useRef<HTMLInputElement | null>(null);
     const [loading, setLoading] = useState(false);
     const [errorMessage, setErrorMessage] = useState<string | null>(null);

     // Progress tracking states
     const [progressPage, setProgressPage] = useState(0);
     const [totalPages, setTotalPages] = useState(0);
     const [isModalOpen, setIsModalOpen] = useState(false);
     const [status, setStatus] = useState<"processing" | "complete" | "error">("processing");

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
          setProgressPage(0);
          setTotalPages(0);
          setStatus("processing");
          setIsModalOpen(true);

          try {
               const formData = new FormData();
               formData.append("pdf", file);

               const res = await fetch("/api/paddleocr/extract", {
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
                              if (msg.type === "total") {
                                   setTotalPages(msg.value);
                              } else if (msg.type === "page") {
                                   setProgressPage(msg.value);
                              } else if (msg.type === "complete") {
                                   const data = msg.data;
                                   const blob = new Blob([JSON.stringify(data, null, 2)], {
                                        type: "application/json",
                                   });
                                   const url = URL.createObjectURL(blob);
                                   const anchor = document.createElement("a");
                                   anchor.href = url;
                                   anchor.download = file.name.replace(/\.pdf$/i, "-ocr.json");
                                   document.body.appendChild(anchor);
                                   anchor.click();
                                   document.body.removeChild(anchor);
                                   URL.revokeObjectURL(url);

                                   setStatus("complete");
                                   toast.success("OCR extraction complete — JSON downloaded");
                                   setTimeout(() => setIsModalOpen(false), 2000);
                              } else if (msg.type === "error") {
                                   throw new Error(msg.message);
                              }
                         } catch (err) {
                              console.error("Error parsing NDJSON chunk:", err);
                         }
                    }
               }
          } catch (err) {
               const msg = err instanceof Error ? err.message : "OCR extraction failed";
               setStatus("error");
               toast.error(msg);
          } finally {
               setLoading(false);
          }
     };

     return (
          <>
               <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    title="Get related papers (OCR PDF → JSON)"
                    className="active:border-none hover:bg-light-200 hover:dark:bg-dark-200 p-2 rounded-lg focus:outline-none text-black/50 dark:text-white/50 active:scale-95 transition duration-200 hover:text-black dark:hover:text-white"
               >
                    <input type="file" accept=".pdf" onChange={handleChange} ref={fileInputRef} hidden />
                    <FileText size={16} className="text-[#F8B692]" />
               </button>

               <AnimatePresence>
                    {isModalOpen && (
                         <Dialog
                              open={isModalOpen}
                              onClose={() => status !== "processing" && setIsModalOpen(false)}
                              className="relative z-50"
                         >
                              <motion.div
                                   initial={{ opacity: 0 }}
                                   animate={{ opacity: 1 }}
                                   exit={{ opacity: 0 }}
                                   className="fixed inset-0 bg-black/40 backdrop-blur-sm"
                                   aria-hidden="true"
                              />

                              <div className="fixed inset-0 flex items-center justify-center p-4">
                                   <DialogPanel
                                        as={motion.div}
                                        initial={{ opacity: 0, scale: 0.95 }}
                                        animate={{ opacity: 1, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.95 }}
                                        className="mx-auto max-w-sm w-full rounded-2xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 shadow-2xl p-6"
                                   >
                                        <div className="flex items-center justify-between mb-4">
                                             <DialogTitle className="text-lg font-semibold text-black dark:text-white">
                                                  {status === "processing"
                                                       ? "Extracting Text..."
                                                       : status === "complete"
                                                         ? "Success!"
                                                         : "Error"}
                                             </DialogTitle>
                                             {status !== "processing" && (
                                                  <button
                                                       onClick={() => setIsModalOpen(false)}
                                                       className="text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white transition-colors"
                                                  >
                                                       <X size={20} />
                                                  </button>
                                             )}
                                        </div>

                                        <div className="space-y-4">
                                             <Description className="text-sm text-black/60 dark:text-white/60">
                                                  {status === "processing"
                                                       ? "PaddleOCR-VL is processing your PDF file. This may take a minute."
                                                       : status === "complete"
                                                         ? "OCR extraction is finished and your file is downloading."
                                                         : "There was an error processing the OCR task."}
                                             </Description>

                                             {status === "processing" && (
                                                  <div className="space-y-2">
                                                       <div className="flex justify-between text-xs font-medium text-black/70 dark:text-white/70">
                                                            <span>
                                                                 {progressPage > 0
                                                                      ? `Page ${progressPage}${totalPages ? ` of ${totalPages}` : ""}`
                                                                      : "Starting models..."}
                                                            </span>
                                                            {totalPages > 0 && (
                                                                 <span>
                                                                      {Math.round((progressPage / totalPages) * 100)}%
                                                                 </span>
                                                            )}
                                                       </div>
                                                       <div className="h-2 w-full bg-light-200 dark:bg-dark-200 rounded-full overflow-hidden">
                                                            <motion.div
                                                                 className="h-full bg-[#F8B692]"
                                                                 initial={{ width: 0 }}
                                                                 animate={{
                                                                      width: totalPages
                                                                           ? `${(progressPage / totalPages) * 100}%`
                                                                           : progressPage > 0
                                                                             ? "5%"
                                                                             : "0%",
                                                                 }}
                                                                 transition={{ duration: 0.5 }}
                                                            />
                                                       </div>
                                                  </div>
                                             )}

                                             {status === "processing" && (
                                                  <div className="flex justify-center pt-2">
                                                       <Loader2 className="w-6 h-6 animate-spin text-[#F8B692]" />
                                                  </div>
                                             )}
                                        </div>
                                   </DialogPanel>
                              </div>
                         </Dialog>
                    )}
               </AnimatePresence>

               {errorMessage && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
                         <div className="w-full max-w-sm bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl shadow-xl p-6 space-y-4">
                              <div className="flex items-start justify-between gap-4">
                                   <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900/40">
                                             <X className="w-4 h-4 text-red-600 dark:text-red-400" />
                                        </div>
                                        <p className="text-base font-semibold text-black dark:text-white">
                                             Invalid file
                                        </p>
                                   </div>
                                   <button
                                        type="button"
                                        onClick={() => setErrorMessage(null)}
                                        className="p-1 rounded-full text-black/60 dark:text-white/60 hover:bg-light-200/80 dark:hover:bg-dark-200/80"
                                   >
                                        <X className="w-4 h-4" />
                                   </button>
                              </div>
                              <p className="text-sm text-black/70 dark:text-white/70">{errorMessage}</p>
                              <div className="flex justify-end">
                                   <button
                                        type="button"
                                        onClick={() => setErrorMessage(null)}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Close
                                   </button>
                              </div>
                         </div>
                    </div>
               )}
          </>
     );
};

export default GetRelatedPapers;
