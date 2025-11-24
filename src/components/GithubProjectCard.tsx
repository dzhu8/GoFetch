"use client";

import Image from "next/image";
import GithubIcon from "@/assets/Octicons-mark-github.svg";
import { FolderGit2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type GithubProjectCardProps = {
     folderName: string;
     githubUrl: string;
     filesChanged: number;
     filesAdded: number;
     filesDeleted: number;
     linesAdded: number;
     linesDeleted: number;
     onSync?: () => void;
};

const GithubProjectCard = ({
     folderName,
     githubUrl,
     filesChanged,
     filesAdded,
     filesDeleted,
     linesAdded,
     linesDeleted,
     onSync,
}: GithubProjectCardProps) => {
     const [isSyncing, setIsSyncing] = useState(false);

     // Extract repository name from URL for display
     const repoPath = githubUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");

     const handleSync = async () => {
          setIsSyncing(true);
          try {
               const res = await fetch(`/api/folders/${encodeURIComponent(folderName)}/sync`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
               });

               if (!res.ok) {
                    const error = await res.json();
                    throw new Error(error.message || "Failed to sync folder");
               }

               toast.success(`Successfully synced ${folderName}`);
               onSync?.();
          } catch (error) {
               console.error("Error syncing folder:", error);
               toast.error(error instanceof Error ? error.message : "Failed to sync folder");
          } finally {
               setIsSyncing(false);
          }
     };

     return (
          <div className="bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-xl p-4 hover:shadow-md transition-all duration-200">
               {/* Header Section */}
               <div className="mb-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                         <div className="flex items-center gap-2 flex-1 min-w-0">
                              <FolderGit2 className="w-5 h-5 text-black/70 dark:text-white/70 flex-shrink-0" />
                              <h3 className="text-base font-medium text-black dark:text-white truncate">
                                   {folderName}
                              </h3>
                         </div>
                         <button
                              onClick={handleSync}
                              disabled={isSyncing}
                              className="flex-shrink-0 p-1.5 rounded-lg text-black/60 dark:text-white/60 hover:text-black dark:hover:text-white hover:bg-light-200 dark:hover:bg-dark-200 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Pull from remote"
                         >
                              <RefreshCw className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`} />
                         </button>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-black/50 dark:text-white/50">
                         <Image src={GithubIcon} alt="GitHub" width={14} height={14} className="opacity-60" />
                         <span>|</span>
                         <a
                              href={githubUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-black dark:hover:text-white transition-colors truncate"
                              title={githubUrl}
                         >
                              {repoPath}
                         </a>
                    </div>
               </div>

               {/* Stats Section */}
               <div className="pt-3 border-t border-light-200 dark:border-dark-200">
                    <div className="flex flex-col gap-1.5 text-xs">
                         {/* Files Changed */}
                         <div className="flex items-center justify-between">
                              <span className="text-black/60 dark:text-white/60">Files changed:</span>
                              <span className="font-medium text-black dark:text-white">{filesChanged}</span>
                         </div>

                         {/* Files Added/Deleted */}
                         <div className="flex items-center justify-between">
                              <span className="text-black/60 dark:text-white/60">Files added/deleted:</span>
                              <div className="flex items-center gap-2">
                                   <span className="text-green-600 dark:text-green-400 font-medium">+{filesAdded}</span>
                                   <span className="text-red-600 dark:text-red-400 font-medium">-{filesDeleted}</span>
                              </div>
                         </div>

                         {/* Lines Added/Deleted */}
                         <div className="flex items-center justify-between">
                              <span className="text-black/60 dark:text-white/60">Lines added/deleted:</span>
                              <div className="flex items-center gap-2">
                                   <span className="text-green-600 dark:text-green-400 font-medium">
                                        +{linesAdded.toLocaleString()}
                                   </span>
                                   <span className="text-red-600 dark:text-red-400 font-medium">
                                        -{linesDeleted.toLocaleString()}
                                   </span>
                              </div>
                         </div>
                    </div>
               </div>
          </div>
     );
};

export default GithubProjectCard;
