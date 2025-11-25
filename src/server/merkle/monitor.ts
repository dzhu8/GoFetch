import type { FolderRegistration } from "@/server/folderRegistry";

import { buildMerkleDag } from "./dag";
import { diffMerkleNodes } from "./diff";
import merkleStore from "./store";

interface TrackedFolder {
     name: string;
     rootPath: string;
}

class MerkleMonitor {
     private folders = new Map<string, TrackedFolder>();
     private timer: NodeJS.Timeout | null = null;
     private polling = false;
     private readonly intervalMs = 10_000;

     registerFolder(folder: FolderRegistration): void {
          this.folders.set(folder.name, { name: folder.name, rootPath: folder.rootPath });
          this.ensureTimer();
     }

     updateFolder(folder: FolderRegistration): void {
          this.registerFolder(folder);
     }

     unregisterFolder(name: string): void {
          this.folders.delete(name);
          if (this.folders.size === 0) {
               this.stopTimer();
          }
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
               }

               const folderId = merkleStore.persistBuild(folder.name, folder.rootPath, build);
               merkleStore.touchFolderCheck(folderId);
          } catch (error) {
               console.error(`[merkle] Failed to poll folder ${folder.name}:`, error);
          }
     }
}

const merkleMonitor = new MerkleMonitor();
export default merkleMonitor;
