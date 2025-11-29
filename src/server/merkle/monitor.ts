import { buildMerkleDag } from "./dag";
import { diffMerkleNodes } from "./diff";
import merkleStore from "./store";
import cliWatcher, { pathsAreEqual, type FolderChangeEvent } from "../cliWatcher";
import type { MerkleDiff } from "./types";

interface TrackedFolder {
     name: string;
     rootPath: string;
}

interface FolderRegistrationInput {
     name: string;
     rootPath: string;
}

type FolderDiffListener = (payload: { folderName: string; diff: MerkleDiff }) => void;

class MerkleMonitor {
     private folders = new Map<string, TrackedFolder>();
     private timer: NodeJS.Timeout | null = null;
     private polling = false;
     private readonly intervalMs = 60_000; // Fallback polling interval (increased from 10s)
     private listeners = new Map<string, Set<FolderDiffListener>>();
     private useCliWatcher = false;
     private cliWatcherInitialized = false;

     /**
      * Initialize CLI watcher integration.
      * Should be called once during app startup.
      */
     async initializeCliWatcher(): Promise<void> {
          if (this.cliWatcherInitialized) {
               return;
          }

          this.cliWatcherInitialized = true;

          // Check if CLI watcher is available
          const available = await cliWatcher.isAvailable();

          if (available) {
               console.log("[merkle] CLI watcher available, using event-driven monitoring");
               this.useCliWatcher = true;

               // Subscribe to folder change events
               cliWatcher.on("folder-change", (event) => {
                    this.handleCliWatcherEvent(event);
               });

               cliWatcher.on("disconnected", () => {
                    console.warn("[merkle] CLI watcher disconnected, falling back to polling");
                    this.useCliWatcher = false;
                    this.ensureTimer();
               });

               cliWatcher.on("connected", async () => {
                    console.log("[merkle] CLI watcher reconnected, switching to event-driven mode");
                    this.useCliWatcher = true;
                    this.stopTimer();

                    // Re-register all folders with CLI watcher
                    for (const folder of this.folders.values()) {
                         await cliWatcher.watchFolder(folder.rootPath);
                    }
               });

               // Connect to SSE stream
               cliWatcher.connect();

               // Register existing folders with CLI watcher
               for (const folder of this.folders.values()) {
                    await cliWatcher.watchFolder(folder.rootPath);
               }

               // Stop polling timer if running
               this.stopTimer();
          } else {
               console.log("[merkle] CLI watcher not available, using polling fallback");
               this.useCliWatcher = false;
               this.ensureTimer();
          }
     }

     /**
      * Handle file change events from CLI watcher.
      */
     private handleCliWatcherEvent(event: FolderChangeEvent): void {
          // Find the folder that matches the event path
          let matchedFolder: TrackedFolder | null = null;

          for (const folder of this.folders.values()) {
               if (pathsAreEqual(folder.rootPath, event.folderPath)) {
                    matchedFolder = folder;
                    break;
               }
          }

          if (!matchedFolder) {
               console.warn(`[merkle] Received change event for unknown folder: ${event.folderPath}`);
               return;
          }

          console.log(`[merkle] CLI watcher detected ${event.changes.length} change(s) in ${matchedFolder.name}`);

          // Rebuild DAG and check for changes
          this.checkFolder(matchedFolder);
     }

     registerFolder(folder: FolderRegistrationInput): void {
          this.folders.set(folder.name, { name: folder.name, rootPath: folder.rootPath });

          if (this.useCliWatcher) {
               // Register with CLI watcher (async, fire-and-forget)
               cliWatcher.watchFolder(folder.rootPath).catch((error) => {
                    console.error(`[merkle] Failed to register folder with CLI watcher: ${error}`);
               });
          } else {
               this.ensureTimer();
          }
     }

     updateFolder(folder: FolderRegistrationInput): void {
          const existing = this.folders.get(folder.name);

          // If path changed, unwatch old path
          if (existing && existing.rootPath !== folder.rootPath && this.useCliWatcher) {
               cliWatcher.unwatchFolder(existing.rootPath).catch(() => {});
          }

          this.registerFolder(folder);
     }

     unregisterFolder(name: string): void {
          const folder = this.folders.get(name);

          if (folder && this.useCliWatcher) {
               cliWatcher.unwatchFolder(folder.rootPath).catch(() => {});
          }

          this.folders.delete(name);
          this.listeners.delete(name);

          if (this.folders.size === 0) {
               this.stopTimer();
          }
     }

     /**
      * Force an immediate check/rebuild of a folder's DAG.
      * Useful when triggered by external events.
      */
     triggerFolderCheck(name: string): void {
          const folder = this.folders.get(name);
          if (folder) {
               this.checkFolder(folder);
          }
     }

     subscribe(folderName: string, listener: FolderDiffListener): () => void {
          const listenersForFolder = this.listeners.get(folderName) ?? new Set<FolderDiffListener>();
          listenersForFolder.add(listener);
          this.listeners.set(folderName, listenersForFolder);

          // Only start polling if CLI watcher is not active
          if (!this.useCliWatcher) {
               this.ensureTimer();
          }

          return () => {
               const current = this.listeners.get(folderName);
               if (!current) {
                    return;
               }

               current.delete(listener);
               if (current.size === 0) {
                    this.listeners.delete(folderName);
               }
          };
     }

     private ensureTimer(): void {
          if (this.timer) {
               return;
          }

          this.timer = setInterval(() => this.poll(), this.intervalMs);
          if (typeof this.timer.unref === "function") {
               this.timer.unref();
          }
     }

     private stopTimer(): void {
          if (!this.timer) {
               return;
          }

          clearInterval(this.timer);
          this.timer = null;
     }

     private poll(): void {
          if (this.polling) {
               return;
          }

          this.polling = true;
          try {
               for (const folder of this.folders.values()) {
                    this.checkFolder(folder);
               }
          } finally {
               this.polling = false;
          }
     }

     private checkFolder(folder: TrackedFolder): void {
          try {
               const build = buildMerkleDag(folder.rootPath);
               const previousState = merkleStore.loadFolder(folder.name);
               const diff = diffMerkleNodes(previousState?.nodes ?? null, build.nodes);

               if (diff.hasChanges) {
                    console.info(
                         `[merkle] Changes detected in ${folder.name}:`,
                         JSON.stringify({
                              changed: diff.changedFiles,
                              added: diff.addedFiles,
                              deleted: diff.deletedFiles,
                         })
                    );
                    this.notifyListeners(folder.name, diff);
               }

               const folderId = merkleStore.persistBuild(folder.name, folder.rootPath, build);
               merkleStore.touchFolderCheck(folderId);
          } catch (error) {
               console.error(`[merkle] Failed to poll folder ${folder.name}:`, error);
          }
     }

     private notifyListeners(folderName: string, diff: MerkleDiff): void {
          const listenersForFolder = this.listeners.get(folderName);
          if (!listenersForFolder) {
               return;
          }

          for (const listener of listenersForFolder) {
               try {
                    listener({ folderName, diff });
               } catch (error) {
                    console.error(`[merkle] Failed to notify listener for ${folderName}:`, error);
               }
          }
     }
}

const merkleMonitor = new MerkleMonitor();

// Initialize CLI watcher integration asynchronously
merkleMonitor.initializeCliWatcher().catch((error) => {
     console.error("[merkle] Failed to initialize CLI watcher:", error);
});

export default merkleMonitor;
