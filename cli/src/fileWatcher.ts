import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

/**
 * Directories that should never be watched (common build artifacts, deps, etc.)
 */
const IGNORED_DIRECTORIES = new Set([
     "node_modules",
     ".git",
     ".svn",
     ".hg",
     "dist",
     "build",
     "out",
     ".next",
     ".nuxt",
     ".output",
     "coverage",
     "__pycache__",
     ".pytest_cache",
     ".mypy_cache",
     "venv",
     ".venv",
     "env",
     ".env",
     "vendor",
     "target",
     ".idea",
     ".vscode",
]);

/**
 * File extensions that are supported for AST parsing.
 * Only changes to files with these extensions will trigger events.
 * This list should match the extensions in src/lib/ast/languages.ts
 */
const SUPPORTED_EXTENSIONS = new Set([
     ".js",
     ".cjs",
     ".mjs",
     ".jsx",
     ".ts",
     ".tsx",
     ".py",
     ".rs",
     ".css",
     ".scss",
     ".sass",
     ".less",
     ".html",
     ".htm",
]);

/**
 * Debounce time in milliseconds to batch rapid file changes.
 */
const DEBOUNCE_MS = 500;

export type FileChangeEvent = {
     type: "change" | "add" | "unlink";
     folderPath: string;
     relativePath: string;
     timestamp: number;
};

type WatchedFolder = {
     path: string;
     watcher: fs.FSWatcher;
     debounceTimer: NodeJS.Timeout | null;
     pendingChanges: Map<string, FileChangeEvent["type"]>;
};

class FileWatcherService {
     private watchedFolders = new Map<string, WatchedFolder>();
     private sseClients = new Set<ServerResponse>();
     private eventId = 0;

     /**
      * Start watching a folder for file changes.
      */
     watchFolder(folderPath: string): void {
          const normalizedPath = path.resolve(folderPath);

          if (this.watchedFolders.has(normalizedPath)) {
               console.log(`[watcher] Already watching: ${normalizedPath}`);
               return;
          }

          try {
               const watcher = fs.watch(normalizedPath, { recursive: true }, (eventType, filename) => {
                    if (filename) {
                         this.handleFileEvent(normalizedPath, filename, eventType);
                    }
               });

               watcher.on("error", (error) => {
                    console.error(`[watcher] Error watching ${normalizedPath}:`, error);
                    this.unwatchFolder(normalizedPath);
               });

               this.watchedFolders.set(normalizedPath, {
                    path: normalizedPath,
                    watcher,
                    debounceTimer: null,
                    pendingChanges: new Map(),
               });

               console.log(`[watcher] Started watching: ${normalizedPath}`);
          } catch (error) {
               console.error(`[watcher] Failed to watch ${normalizedPath}:`, error);
          }
     }

     /**
      * Stop watching a folder.
      */
     unwatchFolder(folderPath: string): void {
          const normalizedPath = path.resolve(folderPath);
          const watched = this.watchedFolders.get(normalizedPath);

          if (!watched) {
               return;
          }

          if (watched.debounceTimer) {
               clearTimeout(watched.debounceTimer);
          }

          try {
               watched.watcher.close();
          } catch (error) {
               console.error(`[watcher] Error closing watcher for ${normalizedPath}:`, error);
          }

          this.watchedFolders.delete(normalizedPath);
          console.log(`[watcher] Stopped watching: ${normalizedPath}`);
     }

     /**
      * Get list of currently watched folders.
      */
     getWatchedFolders(): string[] {
          return Array.from(this.watchedFolders.keys());
     }

     /**
      * Add an SSE client to receive file change events.
      */
     addSseClient(res: ServerResponse): void {
          this.sseClients.add(res);
          console.log(`[watcher] SSE client connected. Total: ${this.sseClients.size}`);

          res.on("close", () => {
               this.sseClients.delete(res);
               console.log(`[watcher] SSE client disconnected. Total: ${this.sseClients.size}`);
          });
     }

     /**
      * Handle a file system event with debouncing.
      */
     private handleFileEvent(folderPath: string, filename: string, eventType: string): void {
          // Check if the file is in an ignored directory
          const parts = filename.split(path.sep);
          for (const part of parts) {
               if (IGNORED_DIRECTORIES.has(part)) {
                    return;
               }
          }

          // Only track files with supported extensions
          const ext = path.extname(filename).toLowerCase();
          if (!SUPPORTED_EXTENSIONS.has(ext)) {
               return;
          }

          const watched = this.watchedFolders.get(folderPath);
          if (!watched) {
               return;
          }

          // Map fs.watch event types to our types
          const changeType: FileChangeEvent["type"] = eventType === "rename" ? "change" : "change";
          watched.pendingChanges.set(filename, changeType);

          // Clear existing debounce timer
          if (watched.debounceTimer) {
               clearTimeout(watched.debounceTimer);
          }

          // Set new debounce timer
          watched.debounceTimer = setTimeout(() => {
               this.flushPendingChanges(folderPath);
          }, DEBOUNCE_MS);
     }

     /**
      * Flush pending changes and broadcast to SSE clients.
      */
     private flushPendingChanges(folderPath: string): void {
          const watched = this.watchedFolders.get(folderPath);
          if (!watched || watched.pendingChanges.size === 0) {
               return;
          }

          const changes = Array.from(watched.pendingChanges.entries()).map(([relativePath, type]) => ({
               type,
               folderPath,
               relativePath,
               timestamp: Date.now(),
          }));

          watched.pendingChanges.clear();
          watched.debounceTimer = null;

          console.log(`[watcher] Changes detected in ${folderPath}: ${changes.length} file(s)`);

          // Broadcast to SSE clients
          this.broadcastEvent({
               event: "folder-change",
               data: {
                    folderPath,
                    changes,
                    timestamp: Date.now(),
               },
          });
     }

     /**
      * Broadcast an event to all connected SSE clients.
      */
     private broadcastEvent(event: { event: string; data: unknown }): void {
          if (this.sseClients.size === 0) {
               return;
          }

          this.eventId += 1;
          const message = `id: ${this.eventId}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

          for (const client of this.sseClients) {
               try {
                    client.write(message);
               } catch (error) {
                    console.error("[watcher] Failed to send SSE event:", error);
                    this.sseClients.delete(client);
               }
          }
     }

     /**
      * Clean up all watchers on shutdown.
      */
     shutdown(): void {
          for (const folderPath of this.watchedFolders.keys()) {
               this.unwatchFolder(folderPath);
          }

          for (const client of this.sseClients) {
               try {
                    client.end();
               } catch {
                    // Ignore errors during shutdown
               }
          }
          this.sseClients.clear();
     }
}

const fileWatcher = new FileWatcherService();
export default fileWatcher;
