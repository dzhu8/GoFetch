"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";

type RegisteredFolder = {
     name: string;
     rootPath: string;
     githubUrl?: string | null;
     isGitConnected?: boolean;
};

const CLI_PROTOCOL = process.env.NEXT_PUBLIC_GOFETCH_CLI_PROTOCOL ?? "http";
const CLI_HOST = process.env.NEXT_PUBLIC_GOFETCH_CLI_HOST ?? "127.0.0.1";
const CLI_PORT = process.env.NEXT_PUBLIC_GOFETCH_CLI_PORT ?? "4820";
const CLI_SELECTION_ENDPOINT = `${CLI_PROTOCOL}://${CLI_HOST}:${CLI_PORT}/selection/latest`;
const CLI_SELECTION_PROMPT_ENDPOINT = `${CLI_PROTOCOL}://${CLI_HOST}:${CLI_PORT}/selection/prompt`;

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

const VIEW_TABS = [
     { id: "folders", label: "Folders" },
     { id: "telemetry", label: "Telemetry (coming soon)", disabled: true },
] as const;

type ViewTab = (typeof VIEW_TABS)[number]["id"];

export default function InspectPage() {
     const [folders, setFolders] = useState<RegisteredFolder[]>([]);
     const [monitored, setMonitored] = useState<Set<string>>(new Set());
     const [loadingFolders, setLoadingFolders] = useState(true);
     const [loadingMonitorState, setLoadingMonitorState] = useState(true);
     const [activeView, setActiveView] = useState<ViewTab>("folders");
     const [pendingFolder, setPendingFolder] = useState<string | null>(null);
     const [errorMessage, setErrorMessage] = useState<string | null>(null);
     const [isAddModalOpen, setIsAddModalOpen] = useState(false);
     const [newFolderName, setNewFolderName] = useState("");
     const [newFolderPath, setNewFolderPath] = useState("");
     const [isSavingFolder, setIsSavingFolder] = useState(false);
     const [cliFolderWatcherEnabled, setCliFolderWatcherEnabled] = useState(false);
     const [isPromptingFolder, setIsPromptingFolder] = useState(false);
     const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
     const lastSelectionVersionRef = useRef(0);
     const cliPollingErrorLoggedRef = useRef(false);

     const requestCliSelection = useCallback(async () => {
          const useProxy = shouldProxyCliRequests();
          const targetUrl = useProxy ? "/api/cli/folder-selection" : CLI_SELECTION_ENDPOINT;

          try {
               const res = await fetch(targetUrl, { cache: "no-store" });
               if (!res.ok) {
                    throw new Error(`Request failed with status ${res.status}`);
               }

               cliPollingErrorLoggedRef.current = false;
               return (await res.json()) as {
                    version?: number;
                    selection?: { path: string; name?: string | null } | null;
               };
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

          const data = (await res.json().catch(() => null)) as {
               status?: string;
               selection?: { path: string; name?: string | null } | null;
               error?: string;
          } | null;

          if (!res.ok) {
               throw new Error(data?.error || "Failed to open the native folder picker.");
          }

          return data;
     }, []);

     const fetchFolders = useCallback(async () => {
          try {
               setLoadingFolders(true);
               const res = await fetch("/api/folders", { cache: "no-store" });
               if (!res.ok) throw new Error("Failed to load folders");
               const data = (await res.json()) as { folders: RegisteredFolder[] };
               setFolders(data.folders ?? []);
          } catch (error) {
               console.error("Failed to load folders", error);
               setErrorMessage("Unable to load folders. Please try again.");
          } finally {
               setLoadingFolders(false);
          }
     }, []);

     const fetchMonitored = useCallback(async () => {
          try {
               setLoadingMonitorState(true);
               const res = await fetch("/api/monitoring", { cache: "no-store" });
               if (!res.ok) throw new Error("Failed to load monitoring state");
               const data = (await res.json()) as { monitored?: string[] };
               setMonitored(new Set(data.monitored ?? []));
          } catch (error) {
               console.error("Failed to load monitoring state", error);
               setErrorMessage("Unable to load monitoring state.");
          } finally {
               setLoadingMonitorState(false);
          }
     }, []);

     useEffect(() => {
          fetchFolders();
     }, [fetchFolders]);

     useEffect(() => {
          if (loadingFolders) {
               return;
          }

          if (folders.length === 0) {
               setMonitored(new Set());
               setLoadingMonitorState(false);
               return;
          }

          fetchMonitored();
     }, [folders, loadingFolders, fetchMonitored]);

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
               lastSelectionVersionRef.current = 0;
               return undefined;
          }

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

     const handleToggleMonitoring = async (folderName: string, enabled: boolean) => {
          setPendingFolder(folderName);
          try {
               const res = await fetch("/api/monitoring", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ folderName, enabled }),
               });

               const data = await res.json().catch(() => ({}));

               if (!res.ok) {
                    throw new Error(data?.error ?? "Failed to update monitoring state.");
               }

               setMonitored(new Set((data?.monitored as string[]) ?? []));
          } catch (error) {
               console.error("Failed to toggle monitoring", error);
               setErrorMessage(error instanceof Error ? error.message : "Failed to update monitoring state.");
          } finally {
               setPendingFolder(null);
          }
     };

     const saveFolder = async (folderName: string, folderPath: string) => {
          const trimmedName = folderName.trim();
          const trimmedPath = folderPath.trim();

          if (!trimmedName || !trimmedPath) {
               setErrorMessage("Folder name and path are required.");
               return false;
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

               setIsAddModalOpen(false);
               setNewFolderName("");
               setNewFolderPath("");
               await fetchFolders();
               return true;
          } catch (error) {
               console.error("Error adding folder:", error);
               setErrorMessage(error instanceof Error ? error.message : "Failed to add folder");
               return false;
          } finally {
               setIsSavingFolder(false);
          }
     };

     const handleAddFolder = async () => {
          await saveFolder(newFolderName, newFolderPath);
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
               setErrorMessage("Unable to open the native folder picker. Please add the folder manually.");
               setIsAddModalOpen(true);
          } finally {
               setIsPromptingFolder(false);
          }
     };

     const isBusy = loadingFolders || loadingMonitorState;

     const handleDeleteFolder = useCallback(
          async (folderName: string) => {
               const confirmed = typeof window === "undefined" ? true : window.confirm(`Remove ${folderName}?`);
               if (!confirmed) {
                    return;
               }

               setDeletingFolder(folderName);
               try {
                    const res = await fetch(`/api/folders/${encodeURIComponent(folderName)}`, {
                         method: "DELETE",
                         cache: "no-store",
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) {
                         throw new Error(data?.error || data?.message || "Failed to remove folder");
                    }
                    await fetchFolders();
               } catch (error) {
                    console.error("Failed to remove folder", error);
                    setErrorMessage(error instanceof Error ? error.message : "Failed to remove folder");
               } finally {
                    setDeletingFolder((current) => (current === folderName ? null : current));
               }
          },
          [fetchFolders]
     );

     return (
          <div className="h-full flex flex-col">
               <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-4">
                    <div>
                         <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                              Codebase Analytics
                         </h1>
                         <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                              Monitor folders, inspect codebase changes.
                         </p>
                    </div>
                    <div className="flex flex-col items-center gap-3">
                         <button
                              type="button"
                              onClick={handleAddFolderButton}
                              disabled={isPromptingFolder}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black font-medium text-sm hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
                         >
                              {isPromptingFolder ? (
                                   <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                   <Plus className="w-4 h-4" />
                              )}
                              {isPromptingFolder ? "Opening..." : "Add Folder"}
                         </button>
                         <div className="flex flex-wrap justify-center gap-2">
                              {VIEW_TABS.map((tab) => {
                                   const isDisabled = "disabled" in tab && Boolean(tab.disabled);
                                   return (
                                        <button
                                             key={tab.id}
                                             type="button"
                                             onClick={() => {
                                                  if (!isDisabled) {
                                                       setActiveView(tab.id);
                                                  }
                                             }}
                                             disabled={isDisabled}
                                             className={cn(
                                                  "px-4 py-2 rounded-full text-sm font-medium border transition",
                                                  isDisabled && "opacity-40 cursor-not-allowed",
                                                  activeView === tab.id
                                                       ? "bg-[#F8B692] text-black border-[#F8B692]"
                                                       : "bg-transparent text-black/70 dark:text-white/70 border-light-200 dark:border-dark-200"
                                             )}
                                        >
                                             {tab.label}
                                        </button>
                                   );
                              })}
                         </div>
                    </div>
               </div>

               <div className="flex-1 overflow-y-auto px-6 pb-6">
                    {activeView === "folders" && (
                         <div className="max-w-6xl mx-auto">
                              {isBusy ? (
                                   <div className="flex flex-col items-center justify-center py-12">
                                        <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                                        <p className="text-sm text-black/60 dark:text-white/60">Loading folders...</p>
                                   </div>
                              ) : folders.length === 0 ? (
                                   <div className="flex flex-col items-center justify-center py-12 text-center">
                                        <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                             No folders are registered yet
                                        </p>
                                        <p className="text-sm text-black/50 dark:text-white/50">
                                             Add folders from the Sync view to begin monitoring.
                                        </p>
                                   </div>
                              ) : (
                                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        {folders.map((folder) => {
                                             const checked = monitored.has(folder.name);
                                             const disabled = pendingFolder === folder.name;
                                             const isDeleting = deletingFolder === folder.name;
                                             return (
                                                  <div
                                                       key={folder.name}
                                                       className="border-2 border-light-200 dark:border-dark-200 rounded-2xl bg-light-primary/70 dark:bg-dark-primary/60 p-4 flex flex-col gap-3 shadow-sm"
                                                  >
                                                       <div className="flex items-start justify-between gap-3">
                                                            <p className="text-sm font-semibold text-black dark:text-white">
                                                                 {folder.name}
                                                            </p>
                                                            <button
                                                                 type="button"
                                                                 onClick={() => handleDeleteFolder(folder.name)}
                                                                 disabled={isDeleting}
                                                                 className="p-2 rounded-lg border border-light-200 dark:border-dark-200 text-black/60 dark:text-white/60 hover:bg-light-200/60 dark:hover:bg-dark-200/60 disabled:opacity-50"
                                                                 title="Remove folder"
                                                            >
                                                                 {isDeleting ? (
                                                                      <Loader2 className="w-4 h-4 animate-spin" />
                                                                 ) : (
                                                                      <Trash2 className="w-4 h-4" />
                                                                 )}
                                                            </button>
                                                       </div>
                                                       <p className="text-xs text-black/60 dark:text-white/60 truncate">
                                                            {folder.rootPath}
                                                       </p>
                                                       <div className="flex items-center justify-between text-sm">
                                                            <span className="text-black/70 dark:text-white/70">
                                                                 Monitor folder
                                                            </span>
                                                            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                                                                 <input
                                                                      type="checkbox"
                                                                      checked={checked}
                                                                      onChange={(event) =>
                                                                           handleToggleMonitoring(
                                                                                folder.name,
                                                                                event.target.checked
                                                                           )
                                                                      }
                                                                      disabled={disabled}
                                                                      className="h-4 w-4 rounded border-light-200 dark:border-dark-200"
                                                                 />
                                                                 <span className="text-xs text-black/60 dark:text-white/60">
                                                                      {disabled ? "Saving..." : checked ? "On" : "Off"}
                                                                 </span>
                                                            </label>
                                                       </div>
                                                       <p className="text-[11px] text-black/50 dark:text-white/50">
                                                            Creates AST + DAG logs for quick diagnostics. Not yet fully
                                                            implemented!
                                                       </p>
                                                  </div>
                                             );
                                        })}
                                   </div>
                              )}
                         </div>
                    )}

                    {activeView === "telemetry" && (
                         <div className="max-w-3xl mx-auto text-center py-12">
                              <p className="text-base font-medium text-black/70 dark:text-white/70">
                                   Telemetry view will surface monitoring events soon.
                              </p>
                              <p className="text-sm text-black/50 dark:text-white/50">
                                   For now, use the folder view to toggle monitoring output files.
                              </p>
                         </div>
                    )}
               </div>

               {isAddModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <h2 className="text-lg font-semibold text-black dark:text-white mb-4">Add Folder</h2>
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

               {errorMessage && (
                    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 text-center space-y-4">
                              <p className="text-sm text-black dark:text-white">{errorMessage}</p>
                              <button
                                   type="button"
                                   onClick={() => setErrorMessage(null)}
                                   className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82]"
                              >
                                   Close
                              </button>
                         </div>
                    </div>
               )}
          </div>
     );
}
