"use client";

import { SearchStatus } from "@/components/ChatWindow";
import { Search, Database, Cpu, FileCode, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

interface SearchStatusIndicatorProps {
     status: SearchStatus | null;
}

const stageIcons = {
     analyzing: Search,
     searching: Database,
     embedding: Cpu,
     retrieving: FileCode,
     generating: Sparkles,
};

const stageColors = {
     analyzing: "text-blue-500",
     searching: "text-purple-500",
     embedding: "text-orange-500",
     retrieving: "text-green-500",
     generating: "text-pink-500",
};

const SearchStatusIndicator = ({ status }: SearchStatusIndicatorProps) => {
     if (!status) return null;

     const Icon = stageIcons[status.stage];
     const colorClass = stageColors[status.stage];

     return (
          <AnimatePresence mode="wait">
               <motion.div
                    key={status.stage}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="flex items-start gap-3 py-3 px-4 rounded-lg bg-light-secondary/50 dark:bg-dark-secondary/50 border border-light-200 dark:border-dark-200"
               >
                    <div className={`mt-0.5 ${colorClass}`}>
                         <motion.div
                              animate={{ rotate: status.stage === "searching" ? 360 : 0 }}
                              transition={{
                                   duration: 2,
                                   repeat: status.stage === "searching" ? Infinity : 0,
                                   ease: "linear",
                              }}
                         >
                              <Icon size={18} />
                         </motion.div>
                    </div>
                    <div className="flex-1 min-w-0">
                         <p className="text-sm font-medium text-black/80 dark:text-white/80">{status.message}</p>
                         {status.details && (
                              <div className="mt-1 text-xs text-black/50 dark:text-white/50">
                                   {status.details.folderNames && status.details.folderNames.length > 0 && (
                                        <span>Folders: {status.details.folderNames.join(", ")}</span>
                                   )}
                                   {status.details.embeddingCount !== undefined && (
                                        <span className="ml-2">• {status.details.embeddingCount} embeddings</span>
                                   )}
                                   {status.details.resultCount !== undefined && (
                                        <span className="ml-2">• {status.details.resultCount} results</span>
                                   )}
                              </div>
                         )}
                    </div>
                    <motion.div
                         className="flex gap-1"
                         animate={{ opacity: [0.4, 1, 0.4] }}
                         transition={{ duration: 1.5, repeat: Infinity }}
                    >
                         <div className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                         <div className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />
                         <div className="w-1.5 h-1.5 rounded-full bg-current opacity-20" />
                    </motion.div>
               </motion.div>
          </AnimatePresence>
     );
};

export default SearchStatusIndicator;
