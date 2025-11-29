"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, Loader2, Plus, Trash2, X } from "lucide-react";
import { UMAP } from "umap-js";

import { cn } from "@/lib/utils";
import ThreeEmbeddingViewer from "@/components/ThreeEmbeddingViewer";

type RegisteredFolder = {
     name: string;
     rootPath: string;
     githubUrl?: string | null;
     isGitConnected?: boolean;
     updatedAt?: string;
     embeddingCount?: number;
};

type EmbeddingRow = {
     id: number;
     relativePath: string;
     metadata?: Record<string, unknown> | null;
     vector: number[];
};

type PlotPoints = {
     x: number[];
     y: number[];
     z: number[];
     text: string[];
};

const CLI_PROTOCOL = process.env.NEXT_PUBLIC_GOFETCH_CLI_PROTOCOL ?? "http";
const CLI_HOST = process.env.NEXT_PUBLIC_GOFETCH_CLI_HOST ?? "127.0.0.1";
const CLI_PORT = process.env.NEXT_PUBLIC_GOFETCH_CLI_PORT ?? "4820";
const CLI_SELECTION_ENDPOINT = `${CLI_PROTOCOL}://${CLI_HOST}:${CLI_PORT}/selection/latest`;
const CLI_SELECTION_PROMPT_ENDPOINT = `${CLI_PROTOCOL}://${CLI_HOST}:${CLI_PORT}/selection/prompt`;
const LAST_SELECTION_VERSION_STORAGE_KEY = "gofetch:last-cli-selection-version";

const buildLabel = (row: EmbeddingRow) => {
     const metadata = (row.metadata ?? {}) as Record<string, unknown>;
     const rawSymbol = typeof metadata.symbolName === "string" ? metadata.symbolName.trim() : "";
     const nodeType = typeof metadata.nodeType === "string" ? metadata.nodeType : "unknown";
     const nodePath = typeof metadata.nodePath === "string" ? metadata.nodePath : "root";
     const label = rawSymbol.length > 0 ? rawSymbol : nodeType;
     return `${label} @ ${row.relativePath}\n${nodePath}`;
};

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

const VIEW_TABS = [
     { id: "visualize", label: "Visualize embeddings" },
     { id: "query", label: "Visualize query" },
     { id: "delete", label: "Delete embeddings" },
] as const;

type ViewTab = (typeof VIEW_TABS)[number]["id"];

type QueryPoint = {
     x: number;
     y: number;
     z: number;
     text: string;
};

export default function InspectPage() {
     const [folders, setFolders] = useState<RegisteredFolder[]>([]);
     const [loadingFolders, setLoadingFolders] = useState(true);
     const [activeView, setActiveView] = useState<ViewTab>("visualize");
     const [errorMessage, setErrorMessage] = useState<string | null>(null);
     const [infoMessage, setInfoMessage] = useState<string | null>(null);
     const [isAddModalOpen, setIsAddModalOpen] = useState(false);
     const [newFolderName, setNewFolderName] = useState("");
     const [newFolderPath, setNewFolderPath] = useState("");
     const [isSavingFolder, setIsSavingFolder] = useState(false);
     const [cliFolderWatcherEnabled, setCliFolderWatcherEnabled] = useState(false);
     const [isPromptingFolder, setIsPromptingFolder] = useState(false);
     const [deletingFolder, setDeletingFolder] = useState<string | null>(null);
     const [deletingEmbeddings, setDeletingEmbeddings] = useState<string | null>(null);
     const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
     const [plotPoints, setPlotPoints] = useState<{ x: number[]; y: number[]; z: number[]; text: string[] } | null>(
          null
     );
     const [isVisualizing, setIsVisualizing] = useState(false);
     const [dotSize, setDotSize] = useState(5);
     const [isPlotOpen, setIsPlotOpen] = useState(false);
     const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
     const lastSelectionVersionRef = useRef(0);
     const cliPollingErrorLoggedRef = useRef(false);

     // Query visualization state
     const [querySelectedFolders, setQuerySelectedFolders] = useState<Set<string>>(new Set());
     const [isQueryModalOpen, setIsQueryModalOpen] = useState(false);
     const [queryText, setQueryText] = useState("");
     const [isQueryVisualizing, setIsQueryVisualizing] = useState(false);
     const [queryPlotPoints, setQueryPlotPoints] = useState<PlotPoints | null>(null);
     const [queryPoint, setQueryPoint] = useState<QueryPoint | null>(null);
     const [isQueryPlotOpen, setIsQueryPlotOpen] = useState(false);
     const [queryLoadProgress, setQueryLoadProgress] = useState<{ loaded: number; total: number } | null>(null);

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

     const fetchFolders = useCallback(async (silent = false) => {
          try {
               if (!silent) {
                    setLoadingFolders(true);
               }
               const res = await fetch("/api/folders", { cache: "no-store" });
               if (!res.ok) throw new Error("Failed to load folders");
               const data = (await res.json()) as { folders: RegisteredFolder[] };
               setFolders(data.folders ?? []);
          } catch (error) {
               console.error("Failed to load folders", error);
               if (!silent) {
                    setErrorMessage("Unable to load folders. Please try again.");
               }
          } finally {
               if (!silent) {
                    setLoadingFolders(false);
               }
          }
     }, []);

     // Use Server-Sent Events for real-time folder updates instead of polling
     useEffect(() => {
          let eventSource: EventSource | null = null;
          let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
          let isActive = true;

          const connect = () => {
               if (!isActive) return;

               eventSource = new EventSource("/api/folders/stream");

               eventSource.onmessage = (event) => {
                    try {
                         const data = JSON.parse(event.data) as { folders: RegisteredFolder[] };
                         setFolders(data.folders ?? []);
                         setLoadingFolders(false);
                    } catch (error) {
                         console.error("Failed to parse SSE data:", error);
                    }
               };

               eventSource.onerror = () => {
                    // Connection lost, attempt to reconnect after a delay
                    eventSource?.close();
                    eventSource = null;
                    if (isActive) {
                         reconnectTimeout = setTimeout(connect, 5000);
                    }
               };
          };

          connect();

          return () => {
               isActive = false;
               eventSource?.close();
               if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
               }
          };
     }, []);

     useEffect(() => {
          const fetchCliPreference = async () => {
               try {
                    const res = await fetch("/api/config");
                    if (!res.ok) throw new Error("Failed to load configuration");
                    const data = await res.json();
                    setCliFolderWatcherEnabled(Boolean(data.values?.preferences?.cliFolderWatcher));
                    const preferredSize = Number(data.values?.preferences?.embeddingPointSize ?? 5);
                    setDotSize(Number.isFinite(preferredSize) && preferredSize > 0 ? preferredSize : 5);
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

     const handleClosePlot = useCallback(() => {
          setIsPlotOpen(false);
          setPlotPoints(null);
          setSelectedFolder(null);
          setIsVisualizing(false);
          setLoadProgress(null);
     }, []);

     const handleVisualizeFolder = async (folder: RegisteredFolder) => {
          setSelectedFolder(folder.name);
          setIsPlotOpen(true);
          setIsVisualizing(true);
          setPlotPoints(null);
          setLoadProgress(null);

          try {
               // Fetch all embeddings in batches
               const allRows: EmbeddingRow[] = [];
               let offset = 0;
               const batchSize = 500;
               let hasMore = true;
               let total = 0;

               while (hasMore) {
                    const params = new URLSearchParams({
                         folderName: folder.name,
                         limit: String(batchSize),
                         offset: String(offset),
                    });

                    const res = await fetch(`/api/embeddings?${params.toString()}`, { cache: "no-store" });
                    const data = (await res.json().catch(() => ({}))) as {
                         embeddings?: EmbeddingRow[];
                         error?: string;
                         hasMore?: boolean;
                         total?: number;
                    };

                    if (!res.ok) {
                         throw new Error(data?.error || "Failed to load embeddings");
                    }

                    // Get total from first response
                    if (offset === 0) {
                         total = data.total ?? 0;
                         if (total === 0) {
                              setErrorMessage(`No embeddings found for ${folder.name}.`);
                              handleClosePlot();
                              return;
                         }
                         setLoadProgress({ loaded: 0, total });
                    }

                    const rows = data.embeddings ?? [];
                    allRows.push(...rows);
                    hasMore = data.hasMore ?? false;
                    offset += rows.length;

                    setLoadProgress({ loaded: allRows.length, total });

                    // Safety limit to prevent infinite loops
                    if (offset > 10000) {
                         console.warn("Reached safety limit of 10000 embeddings");
                         break;
                    }
               }

               if (allRows.length === 0) {
                    setErrorMessage(`No embeddings found for ${folder.name}.`);
                    handleClosePlot();
                    return;
               }

               const vectors = allRows.map((row) => row.vector);
               const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));
               const reducer = new UMAP({ nComponents: 3, nNeighbors, minDist: 0.25 });
               const coordinates =
                    vectors.length > 1 ? reducer.fit(vectors) : vectors.map((vec) => [vec[0] ?? 0, 0, 0]);

               const payload: PlotPoints = { x: [], y: [], z: [], text: [] };
               coordinates.forEach((point, index) => {
                    const [x = 0, y = 0, z = 0] = point || [];
                    payload.x.push(x);
                    payload.y.push(y);
                    payload.z.push(z);
                    payload.text.push(buildLabel(allRows[index]));
               });

               setPlotPoints(payload);
               setLoadProgress(null);
          } catch (error) {
               console.error("Failed to visualize embeddings", error);
               setPlotPoints(null);
               setErrorMessage(error instanceof Error ? error.message : "Failed to visualize embeddings.");
               handleClosePlot();
          } finally {
               setIsVisualizing(false);
          }
     };

     const handleDeleteEmbeddings = async (folderName: string) => {
          const confirmed =
               typeof window === "undefined"
                    ? true
                    : window.confirm(`Delete embeddings for ${folderName}? This cannot be undone.`);
          if (!confirmed) {
               return;
          }

          setDeletingEmbeddings(folderName);
          try {
               const params = new URLSearchParams({
                    folderName,
               });
               const res = await fetch(`/api/embeddings?${params.toString()}`, {
                    method: "DELETE",
               });
               const data = await res.json().catch(() => ({}));
               if (!res.ok) {
                    throw new Error(data?.error || "Failed to delete embeddings");
               }

               setInfoMessage(`Deleted ${data?.deleted ?? 0} embeddings for ${folderName}.`);
               if (selectedFolder === folderName) {
                    handleClosePlot();
               }
          } catch (error) {
               console.error("Failed to delete embeddings", error);
               setErrorMessage(error instanceof Error ? error.message : "Failed to delete embeddings.");
          } finally {
               setDeletingEmbeddings((current) => (current === folderName ? null : current));
          }
     };

     const isBusy = loadingFolders;

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
                    if (selectedFolder === folderName) {
                         handleClosePlot();
                    }
               } catch (error) {
                    console.error("Failed to remove folder", error);
                    setErrorMessage(error instanceof Error ? error.message : "Failed to remove folder");
               } finally {
                    setDeletingFolder((current) => (current === folderName ? null : current));
               }
          },
          [fetchFolders, handleClosePlot, selectedFolder]
     );

     // Query visualization handlers
     const handleToggleQueryFolder = (folderName: string) => {
          setQuerySelectedFolders((prev) => {
               const next = new Set(prev);
               if (next.has(folderName)) {
                    next.delete(folderName);
               } else {
                    next.add(folderName);
               }
               return next;
          });
     };

     const truncateQueryText = (text: string, maxLength: number = 40) => {
          if (text.length <= maxLength) return text;
          return text.slice(0, maxLength) + "...";
     };

     const handleCloseQueryPlot = useCallback(() => {
          setIsQueryPlotOpen(false);
          setQueryPlotPoints(null);
          setQueryPoint(null);
          setIsQueryVisualizing(false);
          setQueryLoadProgress(null);
     }, []);

     const handleVisualizeQuery = async () => {
          if (querySelectedFolders.size === 0) {
               setErrorMessage("Please select at least one folder.");
               return;
          }

          if (!queryText.trim()) {
               setErrorMessage("Please enter a query.");
               return;
          }

          setIsQueryModalOpen(false);
          setIsQueryPlotOpen(true);
          setIsQueryVisualizing(true);
          setQueryPlotPoints(null);
          setQueryPoint(null);
          setQueryLoadProgress(null);

          try {
               // Step 1: Compute embedding for the query
               const queryRes = await fetch("/api/embeddings/query", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query: queryText.trim() }),
               });
               const queryData = (await queryRes.json().catch(() => ({}))) as {
                    vector?: number[];
                    error?: string;
               };

               if (!queryRes.ok) {
                    throw new Error(queryData?.error || "Failed to compute query embedding");
               }

               const queryVector = queryData.vector;
               if (!queryVector || queryVector.length === 0) {
                    throw new Error("Query embedding response did not contain a vector");
               }

               // Step 2: Fetch all embeddings from selected folders
               const allRows: EmbeddingRow[] = [];
               const selectedFolderNames = Array.from(querySelectedFolders);
               let totalEmbeddings = 0;

               // First, get total counts
               for (const folderName of selectedFolderNames) {
                    const folder = folders.find((f) => f.name === folderName);
                    totalEmbeddings += folder?.embeddingCount ?? 0;
               }

               setQueryLoadProgress({ loaded: 0, total: totalEmbeddings });

               for (const folderName of selectedFolderNames) {
                    let offset = 0;
                    const batchSize = 500;
                    let hasMore = true;

                    while (hasMore) {
                         const params = new URLSearchParams({
                              folderName,
                              limit: String(batchSize),
                              offset: String(offset),
                         });

                         const res = await fetch(`/api/embeddings?${params.toString()}`, { cache: "no-store" });
                         const data = (await res.json().catch(() => ({}))) as {
                              embeddings?: EmbeddingRow[];
                              error?: string;
                              hasMore?: boolean;
                              total?: number;
                         };

                         if (!res.ok) {
                              throw new Error(data?.error || `Failed to load embeddings for ${folderName}`);
                         }

                         const rows = data.embeddings ?? [];
                         allRows.push(...rows);
                         hasMore = data.hasMore ?? false;
                         offset += rows.length;

                         setQueryLoadProgress({ loaded: allRows.length, total: totalEmbeddings });

                         // Safety limit
                         if (allRows.length > 10000) {
                              console.warn("Reached safety limit of 10000 embeddings");
                              break;
                         }
                    }
               }

               if (allRows.length === 0) {
                    setErrorMessage("No embeddings found in selected folders.");
                    handleCloseQueryPlot();
                    return;
               }

               // Step 3: Run UMAP on all vectors including the query vector
               const allVectors = [...allRows.map((row) => row.vector), queryVector];
               const nNeighbors = Math.min(15, Math.max(2, allVectors.length - 1));
               const reducer = new UMAP({ nComponents: 3, nNeighbors, minDist: 0.25 });
               const coordinates =
                    allVectors.length > 1 ? reducer.fit(allVectors) : allVectors.map((vec) => [vec[0] ?? 0, 0, 0]);

               // Separate regular points and query point
               const regularCoords = coordinates.slice(0, -1);
               const queryCoord = coordinates[coordinates.length - 1];

               const payload: PlotPoints = { x: [], y: [], z: [], text: [] };
               regularCoords.forEach((point, index) => {
                    const [x = 0, y = 0, z = 0] = point || [];
                    payload.x.push(x);
                    payload.y.push(y);
                    payload.z.push(z);
                    payload.text.push(buildLabel(allRows[index]));
               });

               const queryPointData: QueryPoint = {
                    x: queryCoord?.[0] ?? 0,
                    y: queryCoord?.[1] ?? 0,
                    z: queryCoord?.[2] ?? 0,
                    text: `User query: ${truncateQueryText(queryText.trim())}`,
               };

               setQueryPlotPoints(payload);
               setQueryPoint(queryPointData);
               setQueryLoadProgress(null);
          } catch (error) {
               console.error("Failed to visualize query", error);
               setQueryPlotPoints(null);
               setQueryPoint(null);
               setErrorMessage(error instanceof Error ? error.message : "Failed to visualize query.");
               handleCloseQueryPlot();
          } finally {
               setIsQueryVisualizing(false);
          }
     };

     return (
          <div className="h-full flex flex-col">
               <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-4">
                    <div>
                         <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                              Codebase Analytics
                         </h1>
                         <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                              Inspect codebase embeddings.
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
                    {activeView === "visualize" && (
                         <div className="max-w-6xl mx-auto space-y-6">
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
                                             Add folders from the Sync view to start collecting embeddings.
                                        </p>
                                   </div>
                              ) : (
                                   <>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                             {folders.map((folder) => {
                                                  const isActive = selectedFolder === folder.name;
                                                  const isDeleting = deletingFolder === folder.name;
                                                  return (
                                                       <div
                                                            key={folder.name}
                                                            role="button"
                                                            tabIndex={0}
                                                            onClick={() => handleVisualizeFolder(folder)}
                                                            onKeyDown={(event) => {
                                                                 if (event.key === "Enter" || event.key === " ") {
                                                                      event.preventDefault();
                                                                      handleVisualizeFolder(folder);
                                                                 }
                                                            }}
                                                            className={cn(
                                                                 "border-2 rounded-2xl bg-light-primary/70 dark:bg-dark-primary/60 p-4 flex flex-col gap-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#F8B692] cursor-pointer",
                                                                 isActive
                                                                      ? "border-[#F8B692]"
                                                                      : "border-light-200 dark:border-dark-200 hover:border-[#F8B692]/70"
                                                            )}
                                                       >
                                                            <div className="flex items-start justify-between gap-3">
                                                                 <p className="text-sm font-semibold text-black dark:text-white">
                                                                      {folder.name}
                                                                 </p>
                                                                 <button
                                                                      type="button"
                                                                      onClick={(event) => {
                                                                           event.stopPropagation();
                                                                           handleDeleteFolder(folder.name);
                                                                      }}
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
                                                            <div className="flex items-center justify-between text-[10px] text-black/40 dark:text-white/40 mt-1">
                                                                 <span>{folder.embeddingCount ?? 0} embeddings</span>
                                                                 {folder.updatedAt && (
                                                                      <span>
                                                                           Updated{" "}
                                                                           {new Date(
                                                                                folder.updatedAt
                                                                           ).toLocaleDateString()}
                                                                      </span>
                                                                 )}
                                                            </div>
                                                            <p className="text-[11px] text-black/50 dark:text-white/50">
                                                                 Click to visualize embeddings in 3D space.
                                                            </p>
                                                       </div>
                                                  );
                                             })}
                                        </div>
                                        <div className="border-2 border-dashed border-light-200 dark:border-dark-200 rounded-2xl bg-light-primary/30 dark:bg-dark-primary/40 p-4 text-sm text-black/70 dark:text-white/70 text-center">
                                             Click any folder to open the embedding viewer.
                                        </div>
                                   </>
                              )}
                         </div>
                    )}

                    {activeView === "query" && (
                         <div className="max-w-6xl mx-auto space-y-6">
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
                                             Add folders from the Sync view to start collecting embeddings.
                                        </p>
                                   </div>
                              ) : (
                                   <>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                             {folders.map((folder) => {
                                                  const isSelected = querySelectedFolders.has(folder.name);
                                                  return (
                                                       <div
                                                            key={folder.name}
                                                            role="button"
                                                            tabIndex={0}
                                                            onClick={() => handleToggleQueryFolder(folder.name)}
                                                            onKeyDown={(event) => {
                                                                 if (event.key === "Enter" || event.key === " ") {
                                                                      event.preventDefault();
                                                                      handleToggleQueryFolder(folder.name);
                                                                 }
                                                            }}
                                                            className={cn(
                                                                 "border-2 rounded-2xl bg-light-primary/70 dark:bg-dark-primary/60 p-4 flex flex-col gap-3 shadow-sm focus:outline-none focus:ring-2 focus:ring-[#F8B692] cursor-pointer",
                                                                 isSelected
                                                                      ? "border-[#F8B692]"
                                                                      : "border-light-200 dark:border-dark-200 hover:border-[#F8B692]/70"
                                                            )}
                                                       >
                                                            <div className="flex items-start justify-between gap-3">
                                                                 <p className="text-sm font-semibold text-black dark:text-white">
                                                                      {folder.name}
                                                                 </p>
                                                                 <input
                                                                      type="checkbox"
                                                                      checked={isSelected}
                                                                      onChange={() =>
                                                                           handleToggleQueryFolder(folder.name)
                                                                      }
                                                                      onClick={(e) => e.stopPropagation()}
                                                                      className="w-4 h-4 rounded border-2 border-light-200 dark:border-dark-200 text-[#F8B692] focus:ring-[#F8B692] cursor-pointer"
                                                                 />
                                                            </div>
                                                            <p className="text-xs text-black/60 dark:text-white/60 truncate">
                                                                 {folder.rootPath}
                                                            </p>
                                                            <div className="flex items-center justify-between text-[10px] text-black/40 dark:text-white/40 mt-1">
                                                                 <span>{folder.embeddingCount ?? 0} embeddings</span>
                                                                 {folder.updatedAt && (
                                                                      <span>
                                                                           Updated{" "}
                                                                           {new Date(
                                                                                folder.updatedAt
                                                                           ).toLocaleDateString()}
                                                                      </span>
                                                                 )}
                                                            </div>
                                                            <p className="text-[11px] text-black/50 dark:text-white/50">
                                                                 {isSelected ? "Selected for query" : "Click to select"}
                                                            </p>
                                                       </div>
                                                  );
                                             })}
                                        </div>
                                        <div className="flex flex-col items-center gap-4">
                                             <button
                                                  type="button"
                                                  onClick={() => setIsQueryModalOpen(true)}
                                                  disabled={querySelectedFolders.size === 0}
                                                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black font-medium text-sm hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
                                             >
                                                  Write test query
                                             </button>
                                             <p className="text-xs text-black/50 dark:text-white/50 text-center">
                                                  {querySelectedFolders.size === 0
                                                       ? "Select folders to enable query visualization"
                                                       : `${querySelectedFolders.size} folder${querySelectedFolders.size > 1 ? "s" : ""} selected`}
                                             </p>
                                        </div>
                                   </>
                              )}
                         </div>
                    )}

                    {activeView === "delete" && (
                         <div className="max-w-4xl mx-auto">
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
                                             Add folders from the Sync view to start collecting embeddings.
                                        </p>
                                   </div>
                              ) : (
                                   <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        {folders.map((folder) => {
                                             const isDeletingVectors = deletingEmbeddings === folder.name;
                                             return (
                                                  <div
                                                       key={folder.name}
                                                       className="border-2 border-light-200 dark:border-dark-200 rounded-2xl bg-light-primary/70 dark:bg-dark-primary/60 p-4 flex flex-col gap-3 shadow-sm"
                                                  >
                                                       <div>
                                                            <p className="text-sm font-semibold text-black dark:text-white">
                                                                 {folder.name}
                                                            </p>
                                                            <p className="text-xs text-black/60 dark:text-white/60 truncate">
                                                                 {folder.rootPath}
                                                            </p>
                                                       </div>
                                                       <p className="text-[11px] text-black/50 dark:text-white/50">
                                                            Removes stored vectors for this folder.
                                                       </p>
                                                       <button
                                                            type="button"
                                                            onClick={() => handleDeleteEmbeddings(folder.name)}
                                                            disabled={isDeletingVectors}
                                                            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-red-200/80 text-black text-xs font-semibold hover:bg-red-200 disabled:opacity-60"
                                                       >
                                                            {isDeletingVectors ? "Deleting..." : "Delete embeddings"}
                                                       </button>
                                                  </div>
                                             );
                                        })}
                                   </div>
                              )}
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

               {infoMessage && (
                    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-md bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 text-center space-y-4">
                              <p className="text-sm text-black dark:text-white">{infoMessage}</p>
                              <button
                                   type="button"
                                   onClick={() => setInfoMessage(null)}
                                   className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82]"
                              >
                                   Close
                              </button>
                         </div>
                    </div>
               )}

               {isPlotOpen && (
                    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-5xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-2xl">
                              <div className="flex items-start justify-between gap-4 mb-4">
                                   <div>
                                        <p className="text-lg font-semibold text-black dark:text-white">
                                             Embedding viewer
                                        </p>
                                        <p className="text-xs text-black/60 dark:text-white/60">
                                             {selectedFolder
                                                  ? `Folder: ${selectedFolder}`
                                                  : "Select a folder to load embeddings."}
                                        </p>
                                   </div>
                                   <button
                                        type="button"
                                        onClick={handleClosePlot}
                                        className="p-2 rounded-full border border-light-200 dark:border-dark-200 text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                        aria-label="Close embedding viewer"
                                   >
                                        <X className="w-4 h-4" />
                                   </button>
                              </div>
                              <div className="h-[60vh] min-h-[360px]">
                                   {isVisualizing ? (
                                        <div className="flex flex-col items-center justify-center h-full gap-4">
                                             <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60" />
                                             {loadProgress ? (
                                                  <div className="w-full max-w-sm space-y-2">
                                                       <div className="flex items-center justify-between text-xs text-black/60 dark:text-white/60">
                                                            <span>Loading embeddings...</span>
                                                            <span>
                                                                 {loadProgress.loaded} / {loadProgress.total}
                                                            </span>
                                                       </div>
                                                       <div className="h-2 w-full rounded-full bg-light-200 dark:bg-dark-200 overflow-hidden">
                                                            <div
                                                                 className="h-full bg-[#F8B692] transition-all duration-300 ease-out"
                                                                 style={{
                                                                      width: `${loadProgress.total > 0 ? (loadProgress.loaded / loadProgress.total) * 100 : 0}%`,
                                                                 }}
                                                            />
                                                       </div>
                                                       <p className="text-center text-xs text-black/50 dark:text-white/50">
                                                            {loadProgress.loaded >= loadProgress.total
                                                                 ? "Running UMAP dimensionality reduction..."
                                                                 : `Fetching ${loadProgress.total} AST node embeddings`}
                                                       </p>
                                                  </div>
                                             ) : (
                                                  <p className="text-sm text-black/60 dark:text-white/60">
                                                       Preparing UMAP projection...
                                                  </p>
                                             )}
                                        </div>
                                   ) : plotPoints ? (
                                        <ThreeEmbeddingViewer points={plotPoints} pointSize={dotSize} />
                                   ) : (
                                        <div className="flex items-center justify-center h-full">
                                             <p className="text-sm text-black/60 dark:text-white/60">
                                                  Select a folder to generate the 3D embedding map.
                                             </p>
                                        </div>
                                   )}
                              </div>
                         </div>
                    </div>
               )}

               {isQueryModalOpen && (
                    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-lg bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-lg">
                              <div className="flex items-start justify-between gap-4 mb-4">
                                   <div>
                                        <h2 className="text-lg font-semibold text-black dark:text-white">
                                             Write test query
                                        </h2>
                                        <p className="text-xs text-black/60 dark:text-white/60 mt-1">
                                             Enter a query to visualize against selected folder embeddings
                                        </p>
                                   </div>
                                   <button
                                        type="button"
                                        onClick={() => {
                                             setIsQueryModalOpen(false);
                                             setQueryText("");
                                        }}
                                        className="p-2 rounded-full border border-light-200 dark:border-dark-200 text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                        aria-label="Close query modal"
                                   >
                                        <X className="w-4 h-4" />
                                   </button>
                              </div>
                              {/* Selected folders chips */}
                              <div className="mb-4">
                                   <p className="text-xs font-medium text-black/70 dark:text-white/70 mb-2">
                                        Selected folders
                                   </p>
                                   <div className="flex flex-wrap gap-2">
                                        {Array.from(querySelectedFolders).map((folderName) => (
                                             <div
                                                  key={folderName}
                                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 text-xs text-black/70 dark:text-white/70"
                                             >
                                                  <Folder className="w-3 h-3" />
                                                  <span>{folderName}</span>
                                             </div>
                                        ))}
                                   </div>
                              </div>
                              {/* Query input */}
                              <div className="mb-6">
                                   <label className="text-xs font-medium text-black/70 dark:text-white/70">Query</label>
                                   <textarea
                                        value={queryText}
                                        onChange={(e) => setQueryText(e.target.value)}
                                        rows={4}
                                        className="mt-1 w-full px-3 py-2 text-sm bg-light-secondary dark:bg-dark-secondary border border-light-200 dark:border-dark-200 rounded-lg text-black dark:text-white focus:outline-none focus:ring-2 focus:ring-[#F8B692] resize-none"
                                        placeholder="Enter your search query or code snippet..."
                                        autoFocus
                                   />
                              </div>
                              <div className="flex justify-end gap-3">
                                   <button
                                        type="button"
                                        onClick={() => {
                                             setIsQueryModalOpen(false);
                                             setQueryText("");
                                        }}
                                        className="px-4 py-2 rounded-lg border border-light-200 dark:border-dark-200 text-sm text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                   >
                                        Cancel
                                   </button>
                                   <button
                                        type="button"
                                        onClick={handleVisualizeQuery}
                                        disabled={!queryText.trim()}
                                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black text-sm font-medium hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                                   >
                                        Visualize query
                                   </button>
                              </div>
                         </div>
                    </div>
               )}

               {isQueryPlotOpen && (
                    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 px-4">
                         <div className="w-full max-w-5xl bg-light-primary dark:bg-dark-primary border border-light-200 dark:border-dark-200 rounded-2xl p-6 shadow-2xl">
                              <div className="flex items-start justify-between gap-4 mb-4">
                                   <div>
                                        <p className="text-lg font-semibold text-black dark:text-white">
                                             Query visualization
                                        </p>
                                        <p className="text-xs text-black/60 dark:text-white/60">
                                             {queryPoint
                                                  ? `Query: "${truncateQueryText(queryText.trim(), 50)}"`
                                                  : "Preparing visualization..."}
                                        </p>
                                   </div>
                                   <button
                                        type="button"
                                        onClick={handleCloseQueryPlot}
                                        className="p-2 rounded-full border border-light-200 dark:border-dark-200 text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60"
                                        aria-label="Close query viewer"
                                   >
                                        <X className="w-4 h-4" />
                                   </button>
                              </div>
                              <div className="h-[60vh] min-h-[360px]">
                                   {isQueryVisualizing ? (
                                        <div className="flex flex-col items-center justify-center h-full gap-4">
                                             <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60" />
                                             {queryLoadProgress ? (
                                                  <div className="w-full max-w-sm space-y-2">
                                                       <div className="flex items-center justify-between text-xs text-black/60 dark:text-white/60">
                                                            <span>Loading embeddings...</span>
                                                            <span>
                                                                 {queryLoadProgress.loaded} / {queryLoadProgress.total}
                                                            </span>
                                                       </div>
                                                       <div className="h-2 w-full rounded-full bg-light-200 dark:bg-dark-200 overflow-hidden">
                                                            <div
                                                                 className="h-full bg-[#F8B692] transition-all duration-300 ease-out"
                                                                 style={{
                                                                      width: `${queryLoadProgress.total > 0 ? (queryLoadProgress.loaded / queryLoadProgress.total) * 100 : 0}%`,
                                                                 }}
                                                            />
                                                       </div>
                                                       <p className="text-center text-xs text-black/50 dark:text-white/50">
                                                            {queryLoadProgress.loaded >= queryLoadProgress.total
                                                                 ? "Running UMAP dimensionality reduction..."
                                                                 : `Fetching embeddings from ${querySelectedFolders.size} folder${querySelectedFolders.size > 1 ? "s" : ""}`}
                                                       </p>
                                                  </div>
                                             ) : (
                                                  <p className="text-sm text-black/60 dark:text-white/60">
                                                       Computing query embedding...
                                                  </p>
                                             )}
                                        </div>
                                   ) : queryPlotPoints && queryPoint ? (
                                        <ThreeEmbeddingViewer
                                             points={queryPlotPoints}
                                             pointSize={dotSize}
                                             queryPoint={queryPoint}
                                        />
                                   ) : (
                                        <div className="flex items-center justify-center h-full">
                                             <p className="text-sm text-black/60 dark:text-white/60">
                                                  Enter a query to generate the 3D visualization.
                                             </p>
                                        </div>
                                   )}
                              </div>
                         </div>
                    </div>
               )}
          </div>
     );
}
