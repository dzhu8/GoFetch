"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { parseReferences } from "@/lib/citations/parseReferences";
import { useChat } from "@/lib/chat/Chat";

const GetRelatedPapers = () => {
     const fileInputRef = useRef<HTMLInputElement | null>(null);
     const [loading, setLoading] = useState(false);
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
          setStatusMessage("Running OCR extraction…");

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
                                   setStatusMessage(`OCR: page ${msg.value}…`);
                              } else if (msg.type === "total") {
                                   setStatusMessage(`OCR: processing ${msg.value} pages…`);
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

               // ── Parse references from the OCR output ──
               setStatusMessage("Parsing citations…");
               const references = parseReferences(ocrResult);

               if (references.length === 0) {
                    toast.info("No citations (reference_content blocks) found in this PDF.");
                    return;
               }

               const terms = references.map((r) => r.searchTerm);
               const isDoiFlags = references.map((r) => r.isDoi);
               const pdfTitle = file.name.replace(/\.pdf$/i, "");

               // ── Search for related papers ──
               setStatusMessage(`Searching ${terms.length} citation terms…`);

               const searchRes = await fetch("/api/paddleocr/related-papers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ terms, isDoiFlags, pdfTitle }),
               });

               if (!searchRes.ok) {
                    const data = await searchRes.json().catch(() => ({}));
                    throw new Error(data.error || "Related papers search failed");
               }

               const searchData = await searchRes.json();

               // ── Add results to chat and navigate ──
               addRelatedPapers(searchData);
               window.history.replaceState(null, "", `/c/${chatId}`);
               toast.success(`Found related papers for ${references.length} citations`);
          } catch (err) {
               const msg = err instanceof Error ? err.message : "Related papers extraction failed";
               toast.error(msg);
          } finally {
               setLoading(false);
               setStatusMessage(null);
          }
     };

     return (
          <>
               {loading ? (
                    <div className="flex items-center gap-2 p-2">
                         <Loader2 size={16} className="animate-spin text-[#F8B692]" />
                         {statusMessage && (
                              <span className="text-xs text-black/50 dark:text-white/50 max-w-[160px] truncate">
                                   {statusMessage}
                              </span>
                         )}
                    </div>
               ) : (
                    <button
                         type="button"
                         onClick={() => fileInputRef.current?.click()}
                         title="Get related papers from PDF citations"
                         className="active:border-none hover:bg-light-200 hover:dark:bg-dark-200 p-2 rounded-lg focus:outline-none text-black/50 dark:text-white/50 active:scale-95 transition duration-200 hover:text-black dark:hover:text-white"
                    >
                         <input type="file" accept=".pdf" onChange={handleChange} ref={fileInputRef} hidden />
                         <FileText size={16} className="text-[#F8B692]" />
                    </button>
               )}

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
