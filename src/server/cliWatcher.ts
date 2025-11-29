import path from "path";
import { EventEmitter } from "events";

const DEFAULT_PROTOCOL = process.env.GOFETCH_CLI_PROTOCOL ?? "http";
const DEFAULT_HOST = process.env.GOFETCH_CLI_HOST ?? "127.0.0.1";
const DEFAULT_PORT = Number(process.env.GOFETCH_CLI_PORT ?? 4820);
const CLI_BASE_URL = `${DEFAULT_PROTOCOL}://${DEFAULT_HOST}:${DEFAULT_PORT}`;

export type FolderChangeEvent = {
     folderPath: string;
     changes: Array<{
          type: "change" | "add" | "unlink";
          relativePath: string;
          timestamp: number;
     }>;
     timestamp: number;
};

type CliWatcherEvents = {
     "folder-change": [FolderChangeEvent];
     connected: [];
     disconnected: [];
     error: [Error];
};

/**
 * Normalizes a file path to use forward slashes and resolves it.
 * This ensures consistent path comparison between CLI (which may send
 * Windows paths) and the main app.
 */
export function normalizePathForComparison(inputPath: string): string {
     // First resolve to absolute path
     const resolved = path.resolve(inputPath);
     // Convert to lowercase on Windows for case-insensitive comparison
     return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Check if two paths refer to the same location, accounting for
 * platform differences (Windows case-insensitivity, path separators).
 */
export function pathsAreEqual(path1: string, path2: string): boolean {
     return normalizePathForComparison(path1) === normalizePathForComparison(path2);
}

class CliWatcherClient extends EventEmitter<CliWatcherEvents> {
     private eventSource: EventSource | null = null;
     private reconnectTimer: NodeJS.Timeout | null = null;
     private reconnectAttempts = 0;
     private maxReconnectAttempts = 10;
     private baseReconnectDelay = 1000;
     private isShuttingDown = false;
     private watchedFolders = new Set<string>();

     constructor() {
          super();
          this.setMaxListeners(100);
     }

     /**
      * Connect to the CLI watcher SSE endpoint.
      */
     connect(): void {
          if (this.eventSource || this.isShuttingDown) {
               return;
          }

          // EventSource is only available in browser environments
          // For server-side, we need to use a different approach
          if (typeof EventSource === "undefined") {
               this.connectServerSide();
               return;
          }

          try {
               this.eventSource = new EventSource(`${CLI_BASE_URL}/watch/events`);

               this.eventSource.addEventListener("connected", () => {
                    console.log("[cliWatcher] Connected to CLI watcher");
                    this.reconnectAttempts = 0;
                    this.emit("connected");
               });

               this.eventSource.addEventListener("folder-change", (event) => {
                    try {
                         const data = JSON.parse(event.data) as FolderChangeEvent;
                         this.emit("folder-change", data);
                    } catch (error) {
                         console.error("[cliWatcher] Failed to parse folder-change event:", error);
                    }
               });

               this.eventSource.onerror = () => {
                    this.handleDisconnect();
               };
          } catch (error) {
               console.error("[cliWatcher] Failed to connect:", error);
               this.scheduleReconnect();
          }
     }

     /**
      * Server-side SSE connection using fetch.
      */
     private async connectServerSide(): Promise<void> {
          if (this.isShuttingDown) {
               return;
          }

          try {
               const response = await fetch(`${CLI_BASE_URL}/watch/events`, {
                    headers: {
                         Accept: "text/event-stream",
                    },
               });

               if (!response.ok || !response.body) {
                    throw new Error(`Failed to connect: ${response.status}`);
               }

               console.log("[cliWatcher] Connected to CLI watcher (server-side)");
               this.reconnectAttempts = 0;
               this.emit("connected");

               const reader = response.body.getReader();
               const decoder = new TextDecoder();
               let buffer = "";

               while (!this.isShuttingDown) {
                    const { done, value } = await reader.read();

                    if (done) {
                         break;
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() ?? "";

                    let currentEvent = "";
                    let currentData = "";

                    for (const line of lines) {
                         if (line.startsWith("event: ")) {
                              currentEvent = line.slice(7);
                         } else if (line.startsWith("data: ")) {
                              currentData = line.slice(6);
                         } else if (line === "" && currentEvent && currentData) {
                              this.handleSseEvent(currentEvent, currentData);
                              currentEvent = "";
                              currentData = "";
                         }
                    }
               }

               this.handleDisconnect();
          } catch (error) {
               console.error("[cliWatcher] Connection error:", error);
               this.handleDisconnect();
          }
     }

     private handleSseEvent(event: string, data: string): void {
          if (event === "connected") {
               // Already handled above
               return;
          }

          if (event === "folder-change") {
               try {
                    const parsed = JSON.parse(data) as FolderChangeEvent;
                    this.emit("folder-change", parsed);
               } catch (error) {
                    console.error("[cliWatcher] Failed to parse folder-change event:", error);
               }
          }
     }

     private handleDisconnect(): void {
          if (this.eventSource) {
               this.eventSource.close();
               this.eventSource = null;
          }

          this.emit("disconnected");

          if (!this.isShuttingDown) {
               this.scheduleReconnect();
          }
     }

     private scheduleReconnect(): void {
          if (this.reconnectTimer || this.isShuttingDown) {
               return;
          }

          if (this.reconnectAttempts >= this.maxReconnectAttempts) {
               console.warn("[cliWatcher] Max reconnect attempts reached, giving up");
               return;
          }

          const delay = Math.min(this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);

          this.reconnectAttempts += 1;
          console.log(`[cliWatcher] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

          this.reconnectTimer = setTimeout(() => {
               this.reconnectTimer = null;
               this.connect();
          }, delay);
     }

     /**
      * Request the CLI to start watching a folder.
      */
     async watchFolder(folderPath: string): Promise<boolean> {
          try {
               const response = await fetch(`${CLI_BASE_URL}/watch`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: folderPath }),
               });

               if (response.ok) {
                    this.watchedFolders.add(normalizePathForComparison(folderPath));
                    //console.log(`[cliWatcher] Started watching: ${folderPath}`);
                    return true;
               }

               console.error(`[cliWatcher] Failed to watch folder: ${response.status}`);
               return false;
          } catch (error) {
               console.error("[cliWatcher] Failed to watch folder:", error);
               return false;
          }
     }

     /**
      * Request the CLI to stop watching a folder.
      */
     async unwatchFolder(folderPath: string): Promise<boolean> {
          try {
               const response = await fetch(`${CLI_BASE_URL}/watch`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: folderPath }),
               });

               if (response.ok) {
                    this.watchedFolders.delete(normalizePathForComparison(folderPath));
                    console.log(`[cliWatcher] Stopped watching: ${folderPath}`);
                    return true;
               }

               console.error(`[cliWatcher] Failed to unwatch folder: ${response.status}`);
               return false;
          } catch (error) {
               console.error("[cliWatcher] Failed to unwatch folder:", error);
               return false;
          }
     }

     /**
      * Check if the CLI watcher service is available.
      */
     async isAvailable(): Promise<boolean> {
          try {
               const response = await fetch(`${CLI_BASE_URL}/health`, {
                    signal: AbortSignal.timeout(2000),
               });
               return response.ok;
          } catch {
               return false;
          }
     }

     /**
      * Disconnect and clean up.
      */
     disconnect(): void {
          this.isShuttingDown = true;

          if (this.reconnectTimer) {
               clearTimeout(this.reconnectTimer);
               this.reconnectTimer = null;
          }

          if (this.eventSource) {
               this.eventSource.close();
               this.eventSource = null;
          }

          this.watchedFolders.clear();
     }
}

const cliWatcher = new CliWatcherClient();
export default cliWatcher;
