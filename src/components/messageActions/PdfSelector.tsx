"use client";

import { cn } from "@/lib/utils";
import { Popover, PopoverButton, PopoverPanel, Transition } from "@headlessui/react";
import { Check, Paperclip } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useChat } from "@/lib/chat/Chat";
import { listReadyPapers } from "@/lib/actions/papers";
import Image from "next/image";

interface ReadyPaper {
     id: number;
     title: string | null;
     fileName: string;
}

const PdfSelector = () => {
     const { attachedPaperIds, setAttachedPaperIds } = useChat();
     const [papers, setPapers] = useState<ReadyPaper[]>([]);
     const [loaded, setLoaded] = useState(false);

     const fetchPapers = async () => {
          const result = await listReadyPapers();
          if (!result.error && result.papers) {
               setPapers(result.papers);
          }
          setLoaded(true);
     };

     const togglePaper = (paperId: number) => {
          setAttachedPaperIds((prev) =>
               prev.includes(paperId) ? prev.filter((id) => id !== paperId) : [...prev, paperId]
          );
     };

     const hasAttached = attachedPaperIds.length > 0;

     return (
          <Popover className="relative">
               {({ open }) => (
                    <>
                         <PopoverButton
                              onClick={() => {
                                   if (!loaded) fetchPapers();
                              }}
                              className={cn(
                                   "flex items-center p-2 rounded-lg transition duration-200 focus:outline-none",
                                   "text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white hover:bg-light-200 dark:hover:bg-dark-200",
                                   (open || hasAttached) && "text-black dark:text-white",
                                   hasAttached && "text-sky-500 dark:text-sky-400"
                              )}
                         >
                              <Paperclip size={18} />
                              {hasAttached && (
                                   <span className="ml-1 text-xs font-medium text-sky-500">
                                        {attachedPaperIds.length}
                                   </span>
                              )}
                         </PopoverButton>

                         <Transition
                              as={Fragment}
                              enter="transition ease-out duration-200"
                              enterFrom="opacity-0 translate-y-1 scale-95"
                              enterTo="opacity-100 translate-y-0 scale-100"
                              leave="transition ease-in duration-150"
                              leaveFrom="opacity-100 translate-y-0 scale-100"
                              leaveTo="opacity-0 translate-y-1 scale-95"
                         >
                              <PopoverPanel className="absolute left-0 bottom-full mb-2 z-50 w-80 origin-bottom-left">
                                   <div className="bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-xl shadow-xl overflow-hidden">
                                        <div className="px-3 py-2 border-b border-light-200 dark:border-dark-200">
                                             <h4 className="text-sm font-medium text-black dark:text-white">
                                                  Attach PDFs as context
                                             </h4>
                                             <p className="text-xs text-black/50 dark:text-white/50 mt-0.5">
                                                  Selected PDFs will be used to answer your question
                                             </p>
                                        </div>
                                        <div className="max-h-64 overflow-y-auto p-1">
                                             {!loaded ? (
                                                  <div className="p-3 text-sm text-black/50 dark:text-white/50 text-center">
                                                       Loading...
                                                  </div>
                                             ) : papers.length === 0 ? (
                                                  <div className="p-3 text-sm text-black/50 dark:text-white/50 text-center">
                                                       No processed PDFs found. Upload and process a PDF first.
                                                  </div>
                                             ) : (
                                                  papers.map((paper) => {
                                                       const isSelected = attachedPaperIds.includes(paper.id);
                                                       return (
                                                            <button
                                                                 key={paper.id}
                                                                 type="button"
                                                                 onClick={() => togglePaper(paper.id)}
                                                                 className={cn(
                                                                      "flex flex-row items-center space-x-3 p-2.5 rounded-lg transition-colors w-full text-left group",
                                                                      isSelected
                                                                           ? "bg-sky-500/10"
                                                                           : "hover:bg-light-200 dark:hover:bg-dark-200"
                                                                 )}
                                                            >
                                                                 <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center">
                                                                      <Image
                                                                           src="/assets/pdf.svg"
                                                                           alt="PDF"
                                                                           width={24}
                                                                           height={24}
                                                                      />
                                                                 </div>
                                                                 <div className="flex-1 min-w-0">
                                                                      <p
                                                                           className={cn(
                                                                                "text-sm truncate",
                                                                                isSelected
                                                                                     ? "text-sky-500 font-medium"
                                                                                     : "text-black dark:text-white"
                                                                           )}
                                                                      >
                                                                           {paper.title || paper.fileName}
                                                                      </p>
                                                                      {paper.title && (
                                                                           <p className="text-xs text-black/40 dark:text-white/40 truncate">
                                                                                {paper.fileName}
                                                                           </p>
                                                                      )}
                                                                 </div>
                                                                 <div className="flex-shrink-0">
                                                                      {isSelected ? (
                                                                           <Check size={16} className="text-sky-500" />
                                                                      ) : (
                                                                           <div className="w-4 h-4 rounded border border-black/20 dark:border-white/20" />
                                                                      )}
                                                                 </div>
                                                            </button>
                                                       );
                                                  })
                                             )}
                                        </div>
                                        {hasAttached && (
                                             <div className="px-3 py-2 border-t border-light-200 dark:border-dark-200">
                                                  <button
                                                       type="button"
                                                       onClick={() => setAttachedPaperIds([])}
                                                       className="text-xs text-black/50 dark:text-white/50 hover:text-black dark:hover:text-white transition-colors"
                                                  >
                                                       Clear all
                                                  </button>
                                             </div>
                                        )}
                                   </div>
                              </PopoverPanel>
                         </Transition>
                    </>
               )}
          </Popover>
     );
};

export default PdfSelector;
