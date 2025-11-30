import path from "node:path";
import type { ServerResponse } from "node:http";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * Directories that should never be watched (common build artifacts, deps, etc.)
 */
const IGNORED_DIRECTORIES = [
     "**/node_modules/**",
     "**/.git/**",
     "**/.svn/**",
     "**/.hg/**",
     "**/dist/**",
     "**/build/**",
     "**/out/**",
     "**/.next/**",
     "**/.nuxt/**",
     "**/.output/**",
     "**/coverage/**",
     "**/__pycache__/**",
     "**/.pytest_cache/**",
     "**/.mypy_cache/**",
     "**/venv/**",
     "**/.venv/**",
     "**/env/**",
     "**/.env/**",
     "**/vendor/**",
     "**/target/**",
     "**/.idea/**",
     "**/.vscode/**",
];

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

/**
 * Grace period in milliseconds after watch setup to ignore spurious events.
 * This helps prevent false positives from initial file system scans.
 */
const WATCH_SETUP_GRACE_PERIOD_MS = 1000;

export type FileChangeEvent = {
     type: "change" | "add" | "unlink";
     folderPath: string;
     relativePath: string;
     timestamp: number;
};

type WatchedFolder = {
     path: string;
     watcher: FSWatcher;
     debounceTimer: NodeJS.Timeout | null;
     pendingChanges: Map<string, FileChangeEvent["type"]>;
     watchStartTime: number;
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
               const watcher = chokidar.watch(normalizedPath, {
                    ignored: IGNORED_DIRECTORIES,
                    persistent: true,
                    ignoreInitial: true, // Don't fire events for existing files on startup
                    awaitWriteFinish: {
                         stabilityThreshold: 300,
                         pollInterval: 100,
                    },
                    usePolling: false, // Use native events, more efficient
               });

               const watchStartTime = Date.now();

               watcher.on("change", (filePath) => {
                    this.handleFileEvent(normalizedPath, filePath, "change", watchStartTime);
               });

               watcher.on("add", (filePath) => {
                    this.handleFileEvent(normalizedPath, filePath, "add", watchStartTime);
               });

               watcher.on("unlink", (filePath) => {
                    this.handleFileEvent(normalizedPath, filePath, "unlink", watchStartTime);
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
                    watchStartTime,
               });

               //console.log(`[watcher] Started watching: ${normalizedPath}`);
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
     private handleFileEvent(
          folderPath: string,
          filePath: string,
          eventType: FileChangeEvent["type"],
          watchStartTime: number
     ): void {
          // Ignore events within grace period after watch setup (spurious initial events)
          if (Date.now() - watchStartTime < WATCH_SETUP_GRACE_PERIOD_MS) {
               return;
          }

          // Get the relative path from the folder being watched
          const relativePath = path.relative(folderPath, filePath);

          // Only track files with supported extensions
          const ext = path.extname(relativePath).toLowerCase();
          if (!SUPPORTED_EXTENSIONS.has(ext)) {
               return;
          }

          const watched = this.watchedFolders.get(folderPath);
          if (!watched) {
               return;
          }

          watched.pendingChanges.set(relativePath, eventType);

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
