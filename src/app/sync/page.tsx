"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import GithubProjectCard from "@/components/GithubProjectCard";
import { Loader2, Plus } from "lucide-react";
import { useTaskProgressActions } from "@/components/progress/TaskProgressProvider";

type FolderSyncData = {
     name: string;
     rootPath: string;
     githubUrl?: string | null;
     isGitConnected: boolean;
     filesChanged: number;
     filesAdded: number;
     filesDeleted: number;
     linesAdded: number;
     linesDeleted: number;
};

type FolderSelectionPayload = {
     path: string;
     name?: string | null;
};

type FolderSelectionResponse = {
     version?: number;
     selection?: FolderSelectionPayload | null;
};

type FolderPromptResponse = {
     status?: string;
     selection?: FolderSelectionPayload | null;
     error?: string;
};

const CLI_PROTOCOL = process.env.NEXT_PUBLIC_GOFETCH_CLI_PROTOCOL ?? "http";
const CLI_HOST = process.env.NEXT_PUBLIC_GOFETCH_CLI_HOST ?? "127.0.0.1";
const CLI_PORT = process.env.NEXT_PUBLIC_GOFETCH_CLI_PORT ?? "4820";
const CLI_SELECTION_ENDPOINT = `${CLI_PROTOCOL}://${CLI_HOST}:${CLI_PORT}/selection/latest`;
const CLI_SELECTION_PROMPT_ENDPOINT = `${CLI_PROTOCOL}://${CLI_HOST}:${CLI_PORT}/selection/prompt`;
const LAST_SELECTION_VERSION_STORAGE_KEY = "gofetch:last-cli-selection-version";

const shouldProxyCliRequests = () => {
     if (typeof window === "undefined") {
          return true;
     }

     const pageProtocol = window.location.protocol.replace(":", "");
     return pageProtocol !== CLI_PROTOCOL;
};

const deriveFolderNameFromPath = (folderPath: string) => {
     const normalizedPath = folderPath.replace(/\\+/g, "/");
     const segments = normalizedPath.split("/").filter(Boolean);
     return segments[segments.length - 1] || "";
};

const getStoredSelectionVersion = () => {
     if (typeof window === "undefined") {
          return 0;
     }

     const rawValue = window.localStorage.getItem(LAST_SELECTION_VERSION_STORAGE_KEY);
     return rawValue ? Number(rawValue) || 0 : 0;
};

const persistSelectionVersion = (version: number) => {
     if (typeof window === "undefined") {
          return;
     }

     window.localStorage.setItem(LAST_SELECTION_VERSION_STORAGE_KEY, version.toString());
};

export default function SyncPage() {
     const [folders, setFolders] = useState<FolderSyncData[]>([]);
     const [isLoading, setIsLoading] = useState(true);
     const [isAddModalOpen, setIsAddModalOpen] = useState(false);
     const [newFolderName, setNewFolderName] = useState("");
     const [newFolderPath, setNewFolderPath] = useState("");
     const [isSavingFolder, setIsSavingFolder] = useState(false);
     const [errorModalMessage, setErrorModalMessage] = useState<string | null>(null);
     const [cliFolderWatcherEnabled, setCliFolderWatcherEnabled] = useState(false);
     const [isPromptingFolder, setIsPromptingFolder] = useState(false);
     const lastSelectionVersionRef = useRef(0);
     const cliPollingErrorLoggedRef = useRef(false);
     const { trackFolderTask } = useTaskProgressActions();

     const requestCliSelection = useCallback(async () => {
          const useProxy = shouldProxyCliRequests();
          const targetUrl = useProxy ? "/api/cli/folder-selection" : CLI_SELECTION_ENDPOINT;

          try {
               const res = await fetch(targetUrl, { cache: "no-store" });
               if (!res.ok) {
                    throw new Error(`Request failed with status ${res.status}`);
               }

               cliPollingErrorLoggedRef.current = false;
               return (await res.json()) as FolderSelectionResponse;
          } catch (error) {
               if (!cliPollingErrorLoggedRef.current) {
                    console.warn("Unable to reach CLI helper:", error);
                    cliPollingErrorLoggedRef.current = true;
               }
               return null;
          }
     }, []);

     const requestCliPrompt = useCallback(async () => {
          const useProxy = shouldProxyCliRequests();
          const targetUrl = useProxy ? "/api/cli/folder-selection/prompt" : CLI_SELECTION_PROMPT_ENDPOINT;

          const res = await fetch(targetUrl, {
               method: "POST",
               cache: "no-store",
          });

          const data = (await res.json().catch(() => null)) as FolderPromptResponse | null;

          if (!res.ok) {
               throw new Error(data?.error || "Failed to open the native folder picker.");
          }

          return data;
     }, []);

     const fetchFolders = async () => {
          try {
               setIsLoading(true);
               const res = await fetch("/api/folders?includeGitData=true");
               if (!res.ok) throw new Error("Failed to fetch folders");

               const data = await res.json();
               const githubFolders = (data.folders || []).filter((folder: FolderSyncData) =>
                    Boolean(folder.isGitConnected && folder.githubUrl)
               );
               setFolders(githubFolders);
          } catch (error) {
               console.error("Error fetching folders:", error);
          } finally {
               setIsLoading(false);
          }
     };

     const saveFolder = async (folderName: string, folderPath: string) => {
          const trimmedName = folderName.trim();
          const trimmedPath = folderPath.trim();

          if (!trimmedName || !trimmedPath) {
               setErrorModalMessage("Folder name and path are required.");
               return null;
          }

          setIsSavingFolder(true);
          try {
               const res = await fetch("/api/folders", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: trimmedName, rootPath: trimmedPath }),
               });

               if (!res.ok) {
                    const error = await res.json().catch(() => ({ error: "Failed to add folder" }));
                    throw new Error(error.message || error.error || "Failed to add folder");
               }

               const verifyRes = await fetch("/api/folders?includeGitData=true");
               if (!verifyRes.ok) throw new Error("Failed to verify folder");

               const verifyData = await verifyRes.json();
               const addedFolder = (verifyData.folders || []).find(
                    (folder: FolderSyncData) => folder.name === trimmedName
               );

               if (!addedFolder || !addedFolder.isGitConnected || !addedFolder.githubUrl) {
                    await fetch(`/api/folders/${encodeURIComponent(trimmedName)}`, { method: "DELETE" });
                    setErrorModalMessage(
                         "The selected folder does not have a GitHub remote. Please connect it to GitHub before adding."
                    );
                    return false;
               }

               setIsAddModalOpen(false);
               setNewFolderName("");
               setNewFolderPath("");
               setFolders(
                    (verifyData.folders || []).filter((folder: FolderSyncData) =>
                         Boolean(folder.isGitConnected && folder.githubUrl)
                    )
               );
               return trimmedName;
          } catch (error) {
               console.error("Error adding folder:", error);
               setErrorModalMessage(error instanceof Error ? error.message : "Failed to add folder");
               return null;
          } finally {
               setIsSavingFolder(false);
          }
     };

     const handleAddFolder = async () => {
          const createdFolderName = await saveFolder(newFolderName, newFolderPath);
          if (createdFolderName) {
               trackFolderTask(createdFolderName);
          }
     };

     const handleAddFolderButton = async () => {
          if (!cliFolderWatcherEnabled) {
               setIsAddModalOpen(true);
               return;
          }

          setIsPromptingFolder(true);
          try {
               const result = await requestCliPrompt();
               const selection = result?.selection;

               if (selection?.path) {
                    const inferredName = selection.name?.trim() || deriveFolderNameFromPath(selection.path);
                    if (inferredName) {
                         setNewFolderName(inferredName);
                    }
                    setNewFolderPath(selection.path);
                    setIsAddModalOpen(true);
                    return;
               }

               if (result?.status === "cancelled") {
                    return;
               }

               setIsAddModalOpen(true);
          } catch (error) {
               console.error("CLI folder prompt failed:", error);
               setErrorModalMessage("Unable to open the native folder picker. Please add the folder manually.");
               setIsAddModalOpen(true);
          } finally {
               setIsPromptingFolder(false);
          }
     };

     useEffect(() => {
          fetchFolders();
     }, []);

     useEffect(() => {
          const fetchCliPreference = async () => {
               try {
                    const res = await fetch("/api/config");
                    if (!res.ok) throw new Error("Failed to load configuration");
                    const data = await res.json();
                    setCliFolderWatcherEnabled(Boolean(data.values?.preferences?.cliFolderWatcher));
               } catch (error) {
                    console.error("Error loading CLI preference:", error);
               }
          };

          fetchCliPreference();
     }, []);

     useEffect(() => {
          if (!cliFolderWatcherEnabled) {
               return undefined;
          }

          lastSelectionVersionRef.current = getStoredSelectionVersion();
          let isActive = true;
          let timeoutId: ReturnType<typeof setTimeout> | undefined;

          const pollSelection = async () => {
               try {
                    const data = await requestCliSelection();
                    if (!data) return;
                    const version = Number(data?.version ?? 0);
                    const selection = data?.selection;

                    if (selection?.path && version > lastSelectionVersionRef.current) {
                         lastSelectionVersionRef.current = version;
                         persistSelectionVersion(version);
                         const inferredName = selection.name?.trim() || deriveFolderNameFromPath(selection.path);

                         if (inferredName) {
                              setNewFolderName(inferredName);
                         }
                         setNewFolderPath(selection.path);
                         setIsAddModalOpen(true);
                    }
               } catch (error) {
                    console.error("Error polling CLI folder selection:", error);
               } finally {
                    if (isActive) {
                         timeoutId = setTimeout(pollSelection, 4000);
                    }
               }
          };

          pollSelection();

          return () => {
               isActive = false;
               if (timeoutId) {
                    clearTimeout(timeoutId);
               }
          };
     }, [cliFolderWatcherEnabled, requestCliSelection]);

     return (
          <>
               <div className="h-full flex flex-col">
                    {/* Header Section - 30% of screen */}
                    <div className="h-[30vh] flex items-center justify-center px-6">
                         <div className="text-center">
                              <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                                   Sync from Github
                              </h1>
                              <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                                   Manage and sync your GitHub repositories
                              </p>
                              <button
                                   type="button"
                                   onClick={handleAddFolderButton}
                                   disabled={isPromptingFolder}
                                   className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black font-medium text-sm hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
                              >
                                   {isPromptingFolder ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                   ) : (
                                        <Plus className="w-4 h-4" />
                                   )}
                                   {isPromptingFolder ? "Opening..." : "Add Folder"}
                              </button>
                         </div>
                    </div>

                    {/* Cards Section - 70% of screen with scrolling */}
                    <div className="flex-1 overflow-y-auto px-6 pb-6">
                         {isLoading ? (
                              <div className="flex flex-col items-center justify-center py-12">
                                   <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                                   <p className="text-sm text-black/60 dark:text-white/60">Loading folders...</p>
                              </div>
                         ) : folders.length === 0 ? (
                              <div className="flex flex-col items-center justify-center py-12 text-center">
                                   <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                        No GitHub repositories found
                                   </p>
                                   <p className="text-sm text-black/50 dark:text-white/50">
                                        Register folders with GitHub remotes to sync
                                   </p>
                              </div>
                         ) : (
                              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-7xl mx-auto">
                                   {folders.map((folder) => (
                                        <GithubProjectCard
                                             key={folder.name}
                                             folderName={folder.name}
                                             githubUrl={folder.githubUrl!}
                                             filesChanged={folder.filesChanged}
                                             filesAdded={folder.filesAdded}
                                             filesDeleted={folder.filesDeleted}
                                             linesAdded={folder.linesAdded}
                                             linesDeleted={folder.linesDeleted}
                                             onSync={fetchFolders}
                                        />
                                   ))}
                              </div>
                         )}
                    </div>
               </div>

               {isAddModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-4">
                                   Add GitHub Folder
                              </h2>
                              <div className="space-y-3">
                                   <div>
                                        <label className="text-xs font-medium text-black/70 dark:text-white/70">
                                             Folder Name
                                        </label>
                                        <input
                                             type="text"
                                             value={newFolderName}
                                             onChange={(e) => setNewFolderName(e.target.value)}
                                             className="mt-1 w-full px-3 py-2 text-sm bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-lg text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-[#F8B692]"
                                             placeholder="e.g. my-repo"
                                        />
                                   </div>
                                   <div>
                                        <label className="text-xs font-medium text-black/70 dark:text-white/70">
                                             Folder Path
                                        </label>
                                        <input
                                             type="text"
                                             value={newFolderPath}
                                             onChange={(e) => setNewFolderPath(e.target.value)}
                                             className="mt-1 w-full px-3 py-2 text-sm bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-lg text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-[#F8B692]"
                                             placeholder="Absolute path to the folder"
                                        />
                                   </div>
                              </div>
                              <div className="flex justify-end gap-3 mt-6">
                                   <button
                                        type="button"
                                        onClick={() => {
                                             setIsAddModalOpen(false);
                                             setNewFolderName("");
                                             setNewFolderPath("");
                                        }}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={handleAddFolder}
                                        disabled={isSavingFolder}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-50"
                                   >
                                        {isSavingFolder ? "Saving..." : "Add Folder"}
                                   </button>
                              </div>
                         </div>
                    </div>
               )}

               {errorModalMessage && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg text-center">
                              <p className="text-sm text-black dark:text-white mb-4">{errorModalMessage}</p>
                              <button
                                   type="button"
                                   onClick={() => setErrorModalMessage(null)}
                                   className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all duration-200"
                              >
                                   Close
                              </button>
                         </div>
                    </div>
               )}
          </>
     );
}
