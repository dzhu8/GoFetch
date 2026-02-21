"use client";

import { useRef, useState } from "react";
import { FileText, LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";

const GetRelatedPapers = () => {
     const fileInputRef = useRef<HTMLInputElement | null>(null);
     const [loading, setLoading] = useState(false);
     const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

               const blob = await res.blob();
               const url = URL.createObjectURL(blob);
               const anchor = document.createElement("a");
               anchor.href = url;
               anchor.download = file.name.replace(/\.pdf$/i, "-ocr.json");
               document.body.appendChild(anchor);
               anchor.click();
               document.body.removeChild(anchor);
               URL.revokeObjectURL(url);

               toast.success("OCR extraction complete — JSON downloaded");
          } catch (err) {
               const msg = err instanceof Error ? err.message : "OCR extraction failed";
               toast.error(msg);
          } finally {
               setLoading(false);
          }
     };

     return (
          <>
               {loading ? (
                    <div className="p-2 rounded-lg text-black/50 dark:text-white/50 transition duration-200">
                         <LoaderCircle size={16} className="text-[#F8B692] animate-spin" />
                    </div>
               ) : (
                    <button
                         type="button"
                         onClick={() => fileInputRef.current?.click()}
                         title="Get related papers (OCR PDF → JSON)"
                         className="active:border-none hover:bg-light-200 hover:dark:bg-dark-200 p-2 rounded-lg focus:outline-none text-black/50 dark:text-white/50 active:scale-95 transition duration-200 hover:text-black dark:hover:text-white"
                    >
                         <input
                              type="file"
                              accept=".pdf"
                              onChange={handleChange}
                              ref={fileInputRef}
                              hidden
                         />
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
