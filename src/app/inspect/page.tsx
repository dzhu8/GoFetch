"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, Loader2, Plus, Trash2, X } from "lucide-react";
import { UMAP } from "umap-js";

import { cn } from "@/lib/utils";
import ThreeEmbeddingViewer from "@/components/ThreeEmbeddingViewer";
import { useTaskProgressActions } from "@/components/progress/TaskProgressProvider";

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

type LibraryChunkRow = {
     id: number;
     paperId: number;
     sectionType: string;
     chunkIndex: number;
     content: string;
     fileName: string;
     title: string | null;
     vector: number[];
};

type PaperLegendEntry = {
     paperId: number;
     paperTitle: string;
     color: { r: number; g: number; b: number };
};

const godsnot_102 = [
     "#FFFF00",
     "#1CE6FF",
     "#FF34FF",
     "#FF4A46",
     "#008941",
     "#006FA6",
     "#A30059",
     "#FFDBE5",
     "#7A4900",
     "#0000A6",
     "#63FFAC",
     "#B79762",
     "#004D43",
     "#8FB0FF",
     "#997D87",
     "#5A0007",
     "#809693",
     "#6A3A4C",
     "#1B4400",
     "#4FC601",
     "#3B5DFF",
     "#4A3B53",
     "#FF2F80",
     "#61615A",
     "#BA0900",
     "#6B7900",
     "#00C2A0",
     "#FFAA92",
     "#FF90C9",
     "#B903AA",
     "#D16100",
     "#DDEFFF",
     "#000035",
     "#7B4F4B",
     "#A1C299",
     "#300018",
     "#0AA6D8",
     "#013349",
     "#00846F",
     "#372101",
     "#FFB500",
     "#C2FFED",
     "#A079BF",
     "#CC0744",
     "#C0B9B2",
     "#C2FF99",
     "#001E09",
     "#00489C",
     "#6F0062",
     "#0CBD66",
     "#EEC3FF",
     "#456D75",
     "#B77B68",
     "#7A87A1",
     "#788D66",
     "#885578",
     "#FAD09F",
     "#FF8A9A",
     "#D157A0",
     "#BEC459",
     "#456648",
     "#0086ED",
     "#886F4C",
     "#34362D",
     "#B4A8BD",
     "#00A6AA",
     "#452C2C",
     "#636375",
     "#A3C8C9",
     "#FF913F",
     "#938A81",
     "#575329",
     "#00FECF",
     "#B05B6F",
     "#8CD0FF",
     "#3B9700",
     "#04F757",
     "#C8A1A1",
     "#1E6E00",
     "#7900D7",
     "#A77500",
     "#6367A9",
     "#A05837",
     "#6B002C",
     "#772600",
     "#D790FF",
     "#9B9700",
     "#549E79",
     "#FFF69F",
     "#201625",
     "#72418F",
     "#BC23FF",
     "#99ADC0",
     "#3A2465",
     "#922329",
     "#5B4534",
     "#FDE8DC",
     "#404E55",
     "#0089A3",
     "#CB7E98",
     "#A4E804",
     "#324E72",
];

const hexToRgb01 = (hex: string): { r: number; g: number; b: number } => {
     const r = parseInt(hex.slice(1, 3), 16) / 255;
     const g = parseInt(hex.slice(3, 5), 16) / 255;
     const b = parseInt(hex.slice(5, 7), 16) / 255;
     return { r, g, b };
};

const getSectionColor = (index: number): { r: number; g: number; b: number } => {
     const colorHex = godsnot_102[index % godsnot_102.length];
     return hexToRgb01(colorHex);
};

const formatSectionLabel = (sectionType: string, n: number): string => {
     switch (sectionType) {
          case "paragraph_title":
               return `text ${n}`;
          case "abstract":
               return n === 1 ? "abstract" : `abstract ${n}`;
          case "figure_title":
               return `figure ${n}`;
          case "table":
               return `table ${n}`;
          case "display_formula":
               return `formula ${n}`;
          default:
               return `${sectionType} ${n}`;
     }
};

const getChunkTitleAndBody = (chunk: LibraryChunkRow): { title: string; body: string } => {
     if (chunk.sectionType === "paragraph_title") {
          const newlineIdx = chunk.content.indexOf("\n");
          if (newlineIdx > 0) {
               return {
                    title: chunk.content.slice(0, newlineIdx).trim(),
                    body: chunk.content.slice(newlineIdx + 1).trim(),
               };
          }
          return { title: "Text", body: chunk.content };
     }
     const titleMap: Record<string, string> = {
          abstract: "Abstract",
          figure_title: "Figure Caption",
          table: "Table",
          display_formula: "Formula",
     };
     return {
          title: titleMap[chunk.sectionType] ?? chunk.sectionType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          body: chunk.content,
     };
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
     const [querySelectedFolderIds, setQuerySelectedFolderIds] = useState<Set<number>>(new Set());
     const [isQueryModalOpen, setIsQueryModalOpen] = useState(false);
     const [queryText, setQueryText] = useState("");
     const [isQueryVisualizing, setIsQueryVisualizing] = useState(false);
     const [queryPlotPoints, setQueryPlotPoints] = useState<PlotPoints | null>(null);
     const [queryColors, setQueryColors] = useState<{ r: number; g: number; b: number }[] | null>(null);
     const [queryPaperLegend, setQueryPaperLegend] = useState<PaperLegendEntry[]>([]);
     const [queryPoint, setQueryPoint] = useState<QueryPoint | null>(null);
     const [isQueryPlotOpen, setIsQueryPlotOpen] = useState(false);
     const [queryLoadProgress, setQueryLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
     const [queryRawChunks, setQueryRawChunks] = useState<LibraryChunkRow[]>([]);
     const [clickedQueryChunk, setClickedQueryChunk] = useState<LibraryChunkRow | null>(null);
     const [queryNearestIndices, setQueryNearestIndices] = useState<number[]>([]);
     const [queryNearestScores, setQueryNearestScores] = useState<number[]>([]);

     // Library tab state
     const [libraryPlotPoints, setLibraryPlotPoints] = useState<PlotPoints | null>(null);
     const [libraryColors, setLibraryColors] = useState<{ r: number; g: number; b: number }[] | null>(null);
     const [libraryPaperLegend, setLibraryPaperLegend] = useState<PaperLegendEntry[]>([]);
     const [isLibraryLoading, setIsLibraryLoading] = useState(false);
     const [libraryError, setLibraryError] = useState<string | null>(null);
     const [libraryLoadProgress, setLibraryLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
     const [libraryLoaded, setLibraryLoaded] = useState(false);
     const [libraryFolders, setLibraryFolders] = useState<{ id: number; name: string; rootPath: string }[]>([]);
     const [isLoadingLibraryFolders, setIsLoadingLibraryFolders] = useState(false);
     const [selectedLibraryFolderId, setSelectedLibraryFolderId] = useState<number | null>(null);
     const [selectedLibraryFolderName, setSelectedLibraryFolderName] = useState<string | null>(null);
     const [libraryRawChunks, setLibraryRawChunks] = useState<LibraryChunkRow[]>([]);
     const [clickedChunk, setClickedChunk] = useState<LibraryChunkRow | null>(null);

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
          const success = await saveFolder(newFolderName, newFolderPath);
          if (success) {
               trackFolderTask(newFolderName.trim());
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
     const handleToggleQueryFolder = (folderId: number) => {
          setQuerySelectedFolderIds((prev) => {
               const next = new Set(prev);
               if (next.has(folderId)) {
                    next.delete(folderId);
               } else {
                    next.add(folderId);
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
          setQueryColors(null);
          setQueryPaperLegend([]);
          setQueryPoint(null);
          setIsQueryVisualizing(false);
          setQueryLoadProgress(null);
          setQueryRawChunks([]);
          setClickedQueryChunk(null);
          setQueryNearestIndices([]);
          setQueryNearestScores([]);
     }, []);

     const handleVisualizeQuery = async () => {
          if (querySelectedFolderIds.size === 0) {
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

               // Step 2: Fetch all embeddings from selected paper library folders
               const allChunks: LibraryChunkRow[] = [];
               const selectedFolderIds = Array.from(querySelectedFolderIds);

               for (const folderId of selectedFolderIds) {
                    let offset = 0;
                    const batchSize = 1000;
                    let hasMore = true;

                    while (hasMore) {
                         const params = new URLSearchParams({
                              folderId: String(folderId),
                              limit: String(batchSize),
                              offset: String(offset),
                         });

                         const res = await fetch(`/api/paper-embeddings?${params.toString()}`, { cache: "no-store" });
                         const data = (await res.json().catch(() => ({}))) as {
                              chunks?: LibraryChunkRow[];
                              error?: string;
                              total?: number;
                         };

                         if (!res.ok) {
                              const folder = libraryFolders.find(f => f.id === folderId);
                              throw new Error(data?.error || `Failed to load embeddings for ${folder?.name || folderId}`);
                         }

                         const batchChunks = data.chunks ?? [];
                         allChunks.push(...batchChunks);
                         
                         // The paper-embeddings API doesn't return hasMore, but we can verify if we got less than limit
                         hasMore = batchChunks.length === batchSize;
                         offset += batchChunks.length;

                         setQueryLoadProgress({ loaded: allChunks.length, total: allChunks.length }); // Total unknown for batches

                         if (allChunks.length > 20000) {
                              console.warn("Reached safety limit of 20000 embeddings");
                              break;
                         }
                    }
               }

               if (allChunks.length === 0) {
                    setErrorMessage("No embeddings found in selected folders.");
                    handleCloseQueryPlot();
                    return;
               }

               // Step 3: Sort chunks to ensure colors are consistent across different runs
               const sortedChunks = [...allChunks].sort((a, b) => {
                    const paperIdA = a.paperId ?? 0;
                    const paperIdB = b.paperId ?? 0;
                    if (paperIdA !== paperIdB) return paperIdA - paperIdB;
                    return a.id - b.id;
               });

               // Step 4: Map sorted chunks into color groups
               const paperColorMap = new Map<number, number>();
               const uniquePaperIdsSet = new Set<number>();
               sortedChunks.forEach((chunk) => {
                    if (chunk.paperId !== undefined && chunk.paperId !== null) {
                         uniquePaperIdsSet.add(chunk.paperId);
                    }
               });

               const sortedPaperIdsArr = Array.from(uniquePaperIdsSet).sort((a, b) => a - b);
               sortedPaperIdsArr.forEach((pid, idx) => {
                    paperColorMap.set(pid, idx % godsnot_102.length);
               });

               // Prepare Legend
               const paperMap = new Map<number, string>();
               sortedChunks.forEach((chunk) => {
                    if (chunk.paperId) {
                         const paperName = chunk.title?.trim() || chunk.fileName.replace(/\.pdf$/i, "");
                         paperMap.set(chunk.paperId, paperName);
                    }
               });

               const newLegendItems: PaperLegendEntry[] = sortedPaperIdsArr.map((pid) => ({
                    paperId: pid,
                    paperTitle: paperMap.get(pid) || `Paper ${pid}`,
                    color: hexToRgb01(godsnot_102[paperColorMap.get(pid)!]),
               }));
               setQueryPaperLegend(newLegendItems);

               // Step 5: Run UMAP on all vectors including the query vector
               const allVectors = [...sortedChunks.map((row) => row.vector), queryVector];
               const nNeighbors = Math.min(15, Math.max(2, allVectors.length - 1));
               const reducer = new UMAP({ nComponents: 3, nNeighbors, minDist: 0.25 });
               const coordinates =
                    allVectors.length > 1 ? reducer.fit(allVectors) : allVectors.map((vec) => [vec[0] ?? 0, 0, 0]);

               // Separate regular points and query point
               const regularCoords = coordinates.slice(0, -1);
               const queryCoord = coordinates[coordinates.length - 1];

               const payload: PlotPoints = { x: [], y: [], z: [], text: [] };
               const colors: { r: number; g: number; b: number }[] = [];
               regularCoords.forEach((point, index) => {
                    const [x = 0, y = 0, z = 0] = point || [];
                    payload.x.push(x);
                    payload.y.push(y);
                    payload.z.push(z);
                    const chunk = sortedChunks[index];
                    const paperName = chunk.title?.trim() || chunk.fileName.replace(/\.pdf$/i, "");
                    payload.text.push(`${chunk.sectionType} @ ${paperName}`);

                    const colorIdx = chunk.paperId ? (paperColorMap.get(chunk.paperId) ?? 0) : 0;
                    colors.push(hexToRgb01(godsnot_102[colorIdx]));
               });

               const queryPointData: QueryPoint = {
                    x: queryCoord?.[0] ?? 0,
                    y: queryCoord?.[1] ?? 0,
                    z: queryCoord?.[2] ?? 0,
                    text: `User query: ${truncateQueryText(queryText.trim())}`,
               };

               setQueryPlotPoints(payload);
               setQueryColors(colors);
               setQueryPoint(queryPointData);
               setQueryRawChunks(sortedChunks);
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

     const handleQueryPointClick = useCallback(
          (index: number) => {
               if (index >= 0 && index < queryRawChunks.length) {
                    setClickedQueryChunk(queryRawChunks[index]);
               }
          },
          [queryRawChunks]
     );

     const fetchLibraryFolders = useCallback(async () => {
          setIsLoadingLibraryFolders(true);
          try {
               const res = await fetch("/api/library-folders", { cache: "no-store" });
               if (res.ok) {
                    const data = await res.json();
                    setLibraryFolders(data.folders ?? []);
               }
          } catch {}
          finally {
               setIsLoadingLibraryFolders(false);
          }
     }, []);

     const handleSelectLibraryFolder = useCallback(
          (id: number, name: string) => {
               setSelectedLibraryFolderId(id);
               setSelectedLibraryFolderName(name);
               setLibraryLoaded(false);
               setLibraryPlotPoints(null);
               setLibraryColors(null);
               setLibraryPaperLegend([]);
               setLibraryError(null);
               setLibraryRawChunks([]);
               setClickedChunk(null);
          },
          []
     );

     const handleBackToFolders = useCallback(() => {
          setSelectedLibraryFolderId(null);
          setSelectedLibraryFolderName(null);
          setLibraryLoaded(false);
          setLibraryPlotPoints(null);
          setLibraryColors(null);
          setLibraryPaperLegend([]);
          setLibraryError(null);
          setLibraryRawChunks([]);
          setClickedChunk(null);
     }, []);

     const handleLoadLibraryEmbeddings = useCallback(async (folderId: number) => {
          setIsLibraryLoading(true);
          setLibraryError(null);
          setLibraryPlotPoints(null);
          setLibraryColors(null);
          setLibraryPaperLegend([]);
          setLibraryLoadProgress(null);

          try {
               const res = await fetch(`/api/paper-embeddings?folderId=${folderId}&limit=5000`, { cache: "no-store" });
               const data = (await res.json().catch(() => ({}))) as { chunks?: LibraryChunkRow[]; error?: string };
               if (!res.ok) throw new Error(data?.error || "Failed to fetch paper embeddings");

               const raw = data.chunks ?? [];
               if (raw.length === 0) {
                    setLibraryError(
                         "No embedded paper chunks found. Upload papers and wait for embedding to finish."
                    );
                    setLibraryLoaded(true);
                    return;
               }

               // Sort for consistent per-paper section numbering
               const chunks = [...raw].sort((a, b) => {
                    if (a.paperId !== b.paperId) return a.paperId - b.paperId;
                    if (a.sectionType !== b.sectionType) return a.sectionType.localeCompare(b.sectionType);
                    return a.chunkIndex - b.chunkIndex;
               });

               // Assign a distinct color per paper from godsnot_102
               const uniquePaperIds = [...new Set(chunks.map((c) => c.paperId))];
               const paperColorMap = new Map<number, { r: number; g: number; b: number }>();
               uniquePaperIds.forEach((pid, idx) => {
                    paperColorMap.set(pid, hexToRgb01(godsnot_102[idx % godsnot_102.length]));
               });

               // Build legend
               const legend: PaperLegendEntry[] = uniquePaperIds.map((pid) => {
                    const chunk = chunks.find((c) => c.paperId === pid)!;
                    return {
                         paperId: pid,
                         paperTitle: chunk.title?.trim() || chunk.fileName.replace(/\.pdf$/i, ""),
                         color: paperColorMap.get(pid)!,
                    };
               });

               // Build per-paper section-type counters for hover labels
               const sectionCounters = new Map<string, number>();
               const labels = chunks.map((chunk) => {
                    const key = `${chunk.paperId}::${chunk.sectionType}`;
                    const n = (sectionCounters.get(key) ?? 0) + 1;
                    sectionCounters.set(key, n);
                    const paperName = chunk.title?.trim() || chunk.fileName.replace(/\.pdf$/i, "");
                    return `${paperName}\n${formatSectionLabel(chunk.sectionType, n)}`;
               });

               const pointColors = chunks.map((c) => paperColorMap.get(c.paperId)!);

               setLibraryLoadProgress({ loaded: chunks.length, total: chunks.length });

               // Run UMAP
               const vectors = chunks.map((c) => c.vector);
               const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));
               const reducer = new UMAP({ nComponents: 3, nNeighbors, minDist: 0.25 });
               const coordinates =
                    vectors.length > 1 ? reducer.fit(vectors) : vectors.map((v) => [v[0] ?? 0, 0, 0]);

               const payload: PlotPoints = { x: [], y: [], z: [], text: [] };
               coordinates.forEach((point, i) => {
                    const [x = 0, y = 0, z = 0] = point || [];
                    payload.x.push(x);
                    payload.y.push(y);
                    payload.z.push(z);
                    payload.text.push(labels[i]);
               });

               setLibraryPlotPoints(payload);
               setLibraryColors(pointColors);
               setLibraryPaperLegend(legend);
               setLibraryRawChunks(chunks);
               setLibraryLoaded(true);
               setLibraryLoadProgress(null);
          } catch (error) {
               setLibraryError(error instanceof Error ? error.message : "Failed to load library embeddings.");
               setLibraryLoaded(true);
          } finally {
               setIsLibraryLoading(false);
          }
     }, []);

     const handleLibraryPointClick = useCallback((index: number) => {
          setClickedChunk((prev) => {
               const chunk = libraryRawChunks[index] ?? null;
               if (prev && chunk && prev.id === chunk.id) return null;
               return chunk;
          });
     }, [libraryRawChunks]);

     useEffect(() => {
          if (activeView === "visualize" && selectedLibraryFolderId === null) {
               fetchLibraryFolders();
          }
     }, [activeView, selectedLibraryFolderId, fetchLibraryFolders]);

     useEffect(() => {
          if (activeView === "visualize" && selectedLibraryFolderId !== null && !libraryLoaded && !isLibraryLoading) {
               handleLoadLibraryEmbeddings(selectedLibraryFolderId);
          }
     }, [activeView, selectedLibraryFolderId, libraryLoaded, isLibraryLoading, handleLoadLibraryEmbeddings]);

     return (
          <div className="h-full flex flex-col">
               <div className="h-[30vh] flex flex-col items-center justify-center px-6 text-center gap-4">
                    <div>
                         <h1 className="text-3xl md:text-4xl xl:text-5xl font-['Big_Softie'] text-[#F8B692] mb-2">
                              Library Analytics
                         </h1>
                         <p className="text-sm md:text-base text-black/60 dark:text-white/60">
                              Inspect paper embeddings.
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
                         <div className="max-w-6xl mx-auto space-y-4">
                              {selectedLibraryFolderId === null ? (
                                   // Folder picker
                                   isLoadingLibraryFolders ? (
                                        <div className="flex flex-col items-center justify-center py-12">
                                             <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                                             <p className="text-sm text-black/60 dark:text-white/60">Loading folders…</p>
                                        </div>
                                   ) : libraryFolders.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-12 text-center">
                                             <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                                  No library folders yet
                                             </p>
                                             <p className="text-sm text-black/50 dark:text-white/50">
                                                  Add folders in the Library page to get started.
                                             </p>
                                        </div>
                                   ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                             {libraryFolders.map((folder) => (
                                                  <div
                                                       key={folder.id}
                                                       role="button"
                                                       tabIndex={0}
                                                       onClick={() => handleSelectLibraryFolder(folder.id, folder.name)}
                                                       onKeyDown={(e) => {
                                                            if (e.key === "Enter" || e.key === " ") {
                                                                 e.preventDefault();
                                                                 handleSelectLibraryFolder(folder.id, folder.name);
                                                            }
                                                       }}
                                                       className="border-2 border-light-200 dark:border-dark-200 hover:border-[#F8B692]/70 rounded-2xl bg-light-primary/70 dark:bg-dark-primary/60 p-4 flex flex-col gap-2 shadow-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#F8B692] transition"
                                                  >
                                                       <p className="text-sm font-semibold text-black dark:text-white">{folder.name}</p>
                                                       <p className="text-xs text-black/50 dark:text-white/50 truncate">{folder.rootPath}</p>
                                                       <p className="text-[11px] text-black/40 dark:text-white/40 mt-1">
                                                            Click to visualize embeddings
                                                       </p>
                                                  </div>
                                             ))}
                                        </div>
                                   )
                              ) : (
                                   // Viewer for selected folder
                                   <>
                                        <div className="flex items-center justify-between">
                                             <div className="flex items-center gap-3">
                                                  <button
                                                       type="button"
                                                       onClick={handleBackToFolders}
                                                       className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-light-200 dark:border-dark-200 text-xs text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60 transition"
                                                  >
                                                       ← Back
                                                  </button>
                                                  <div>
                                                       <p className="text-sm font-semibold text-black dark:text-white">
                                                            {selectedLibraryFolderName}
                                                       </p>
                                                       <p className="text-xs text-black/50 dark:text-white/50">
                                                            Points colored by document · hover to see section type
                                                       </p>
                                                  </div>
                                             </div>
                                             <button
                                                  type="button"
                                                  onClick={() => {
                                                       setLibraryLoaded(false);
                                                       handleLoadLibraryEmbeddings(selectedLibraryFolderId);
                                                  }}
                                                  disabled={isLibraryLoading}
                                                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-light-200 dark:border-dark-200 text-xs text-black/70 dark:text-white/70 hover:bg-light-200/60 dark:hover:bg-dark-200/60 disabled:opacity-50"
                                             >
                                                  {isLibraryLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                                  Refresh
                                             </button>
                                        </div>

                                        {isLibraryLoading ? (
                                             <div className="flex flex-col items-center justify-center py-16 gap-4">
                                                  <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60" />
                                                  <p className="text-sm text-black/60 dark:text-white/60">
                                                       {libraryLoadProgress
                                                            ? `Running UMAP on ${libraryLoadProgress.total} chunks…`
                                                            : "Loading paper embeddings…"}
                                                  </p>
                                             </div>
                                        ) : libraryError ? (
                                             <div className="flex flex-col items-center justify-center py-12 text-center gap-2">
                                                  <p className="text-sm text-black/70 dark:text-white/70">{libraryError}</p>
                                             </div>
                                        ) : libraryPlotPoints ? (
                                             <>
                                                  <div className="relative h-[65vh] min-h-[360px]">
                                                       <ThreeEmbeddingViewer
                                                            points={libraryPlotPoints}
                                                            pointSize={dotSize}
                                                            colors={libraryColors ?? undefined}
                                                            onPointClick={handleLibraryPointClick}
                                                            onEmptyClick={() => setClickedChunk(null)}
                                                       />
                                                       {clickedChunk && (() => {
                                                            const { title, body } = getChunkTitleAndBody(clickedChunk);
                                                            const paperName = clickedChunk.title?.trim() || clickedChunk.fileName.replace(/\.pdf$/i, "");
                                                            return (
                                                                 <div 
                                                                      className="absolute top-3 right-3 z-10 flex w-[340px] max-w-[45%] max-h-[70%] flex-col rounded-xl border border-white/10 bg-black/85 shadow-2xl backdrop-blur-sm pointer-events-auto"
                                                                 >
                                                                           <div className="flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
                                                                                <div className="min-w-0">
                                                                                     <p className="text-xs font-semibold text-white leading-snug">{title}</p>
                                                                                     <p className="mt-0.5 truncate text-[10px] text-white/50">{paperName}</p>
                                                                                </div>
                                                                                <button
                                                                                     type="button"
                                                                                     onClick={() => setClickedChunk(null)}
                                                                                     className="mt-0.5 flex-shrink-0 rounded p-0.5 text-white/50 hover:text-white transition-colors"
                                                                                     aria-label="Close"
                                                                                >
                                                                                     <X className="h-3.5 w-3.5" />
                                                                                </button>
                                                                           </div>
                                                                           <div className="overflow-y-auto px-4 py-3">
                                                                                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-white/80">{body}</p>
                                                                           </div>
                                                                 </div>
                                                            );
                                                       })()}
                                                  </div>
                                                  {libraryPaperLegend.length > 0 && (
                                                       <div className="flex flex-wrap gap-3 pt-1">
                                                            {libraryPaperLegend.map((entry) => (
                                                                 <div
                                                                      key={entry.paperId}
                                                                      className="flex items-center gap-1.5 text-xs text-black/70 dark:text-white/70"
                                                                 >
                                                                      <span
                                                                           className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                                                                           style={{
                                                                                backgroundColor: `rgb(${Math.round(entry.color.r * 255)}, ${Math.round(entry.color.g * 255)}, ${Math.round(entry.color.b * 255)})`,
                                                                           }}
                                                                      />
                                                                      <span className="truncate max-w-[200px]">{entry.paperTitle}</span>
                                                                 </div>
                                                            ))}
                                                       </div>
                                                  )}
                                             </>
                                        ) : (
                                             <div className="flex flex-col items-center justify-center py-12 text-center">
                                                  <p className="text-sm text-black/60 dark:text-white/60">
                                                       No embedded paper chunks found for this folder.
                                                  </p>
                                             </div>
                                        )}
                                   </>
                              )}
                         </div>
                    )}

                    {activeView === "query" && (
                         <div className="max-w-6xl mx-auto space-y-6">
                              {isLoadingLibraryFolders ? (
                                   <div className="flex flex-col items-center justify-center py-12">
                                        <Loader2 className="w-8 h-8 animate-spin text-black/60 dark:text-white/60 mb-3" />
                                        <p className="text-sm text-black/60 dark:text-white/60">Loading folders...</p>
                                   </div>
                              ) : libraryFolders.length === 0 ? (
                                   <div className="flex flex-col items-center justify-center py-12 text-center">
                                        <p className="text-base font-medium text-black/70 dark:text-white/70 mb-1">
                                             No library folders found
                                        </p>
                                        <p className="text-sm text-black/50 dark:text-white/50">
                                             Add folders from the Library view to start.
                                        </p>
                                   </div>
                              ) : (
                                   <>
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                             {libraryFolders.map((folder) => {
                                                  const isSelected = querySelectedFolderIds.has(folder.id);
                                                  return (
                                                       <div
                                                            key={folder.id}
                                                            role="button"
                                                            tabIndex={0}
                                                            onClick={() => handleToggleQueryFolder(folder.id)}
                                                            onKeyDown={(event) => {
                                                                 if (event.key === "Enter" || event.key === " ") {
                                                                      event.preventDefault();
                                                                      handleToggleQueryFolder(folder.id);
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
                                                                           handleToggleQueryFolder(folder.id)
                                                                      }
                                                                      onClick={(e) => e.stopPropagation()}
                                                                      className="w-4 h-4 rounded border-2 border-light-200 dark:border-dark-200 text-[#F8B692] focus:ring-[#F8B692] cursor-pointer"
                                                                 />
                                                            </div>
                                                            <p className="text-xs text-black/60 dark:text-white/60 truncate">
                                                                 {folder.rootPath}
                                                            </p>
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
                                                  disabled={querySelectedFolderIds.size === 0}
                                                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#F8B692] text-black font-medium text-sm hover:bg-[#e6ad82] active:scale-95 transition-all duration-200 disabled:opacity-60 disabled:cursor-not-allowed"
                                             >
                                                  Write test query
                                             </button>
                                             <p className="text-xs text-black/50 dark:text-white/50 text-center">
                                                  {querySelectedFolderIds.size === 0
                                                       ? "Select folders to enable query visualization"
                                                       : `${querySelectedFolderIds.size} folder${querySelectedFolderIds.size > 1 ? "s" : ""} selected`}
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
                                                                 : `Fetching ${loadProgress.total} embeddings`}
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
                                        {Array.from(querySelectedFolderIds).map((folderName) => (
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
                                                            nearestIndices={queryNearestIndices}
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
                                                                 : `Fetching embeddings from ${querySelectedFolderIds.size} folder${querySelectedFolderIds.size > 1 ? "s" : ""}`}
                                                       </p>
                                                  </div>
                                             ) : (
                                                  <p className="text-sm text-black/60 dark:text-white/60">
                                                       Computing query embedding...
                                                  </p>
                                             )}
                                        </div>
                                   ) : queryPlotPoints && queryPoint ? (
                                        <div className="relative h-full w-full flex flex-col">
                                             <div className="relative flex-grow">
                                                  <ThreeEmbeddingViewer
                                                       points={queryPlotPoints}
                                                       pointSize={dotSize}
                                                       colors={queryColors ?? undefined}
                                                       queryPoint={queryPoint}
                                                       nearestIndices={queryNearestIndices}
                                                       onPointClick={handleQueryPointClick}
                                                       onEmptyClick={() => setClickedQueryChunk(null)}
                                                  />
                                                  {clickedQueryChunk && (() => {
                                                       const { title, body } = getChunkTitleAndBody(clickedQueryChunk);
                                                       const paperName = clickedQueryChunk.title?.trim() || clickedQueryChunk.fileName.replace(/\.pdf$/i, "");
                                                       return (
                                                            <div 
                                                                 className="absolute top-3 right-3 z-10 flex w-[340px] max-w-[45%] max-h-[70%] flex-col rounded-xl border border-white/10 bg-black/85 shadow-2xl backdrop-blur-sm pointer-events-auto"
                                                            >
                                                                 <div className="flex items-start justify-between gap-2 border-b border-white/10 px-4 py-3">
                                                                      <div className="min-w-0">
                                                                           <p className="text-xs font-semibold text-white leading-snug">{title}</p>
                                                                           <p className="mt-0.5 truncate text-[10px] text-white/50">{paperName}</p>
                                                                      </div>
                                                                      <button
                                                                           type="button"
                                                                           onClick={() => setClickedQueryChunk(null)}
                                                                           className="mt-0.5 flex-shrink-0 rounded p-0.5 text-white/50 hover:text-white transition-colors"
                                                                           aria-label="Close"
                                                                      >
                                                                           <X className="h-3.5 w-3.5" />
                                                                      </button>
                                                                 </div>
                                                                 <div className="overflow-y-auto px-4 py-3">
                                                                      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-white/80">{body}</p>
                                                                 </div>
                                                            </div>
                                                       );
                                                  })()}
                                             {queryNearestIndices.length > 0 && (
                                                  <div className="absolute top-4 left-4 w-60 bg-black/80 backdrop-blur-md rounded-xl border border-white/10 p-4 shadow-xl pointer-events-none">
                                                       <h3 className="text-xs font-semibold text-white/90 mb-3 uppercase tracking-wider">
                                                            Top Matches
                                                       </h3>
                                                       <div className="space-y-2">
                                                            {queryNearestIndices.slice(0, 5).map((idx, i) => {
                                                                 const label = queryPlotPoints.text[idx] || "";
                                                                 // Extract just the symbol name or file path for cleaner display
                                                                 const cleanLabel = label.split("\n")[0] || "Unknown";
                                                                 const score = queryNearestScores[i];

                                                                 return (
                                                                      <div
                                                                           key={i}
                                                                           className="flex items-center justify-between gap-2 text-xs"
                                                                      >
                                                                           <span
                                                                                className="text-white/70 truncate flex-1"
                                                                                title={label}
                                                                           >
                                                                                {cleanLabel}
                                                                           </span>
                                                                           {score !== undefined && (
                                                                                <span className="text-[#F8B692] font-mono">
                                                                                     {score.toFixed(3)}
                                                                                </span>
                                                                           )}
                                                                      </div>
                                                                 );
                                                            })}
                                                       </div>
                                                  </div>
                                             )}
                                        </div>
                                        {queryPaperLegend.length > 0 && (
                                             <div className="flex flex-wrap gap-2 py-3 px-4 border-t border-light-200 dark:border-dark-200 mt-2 overflow-y-auto max-h-[100px] shrink-0">
                                                  {queryPaperLegend.map((entry) => (
                                                       <div
                                                            key={entry.paperId}
                                                            className="flex items-center gap-1.5 text-[10px] text-black/70 dark:text-white/70"
                                                       >
                                                            <span
                                                                 className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                                                                 style={{
                                                                      backgroundColor: `rgb(${Math.round(entry.color.r * 255)}, ${Math.round(entry.color.g * 255)}, ${Math.round(entry.color.b * 255)})`,
                                                                 }}
                                                            />
                                                            <span className="truncate max-w-[150px]">{entry.paperTitle}</span>
                                                       </div>
                                                  ))}
                                             </div>
                                        )}
                                   </div>
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
