import { eq } from "drizzle-orm";

import folderRegistry from "@/server/folderRegistry";
import merkleMonitor from "@/server/merkle/monitor";
import db from "@/server/db";
import { folders, monitorEvents } from "@/server/db/schema";
import type { MerkleDiff } from "@/server/merkle/types";

interface ActiveMonitorHandle {
     unsubscribe: () => void;
     folderId: number;
}

class MonitorService {
     private active = new Map<string, ActiveMonitorHandle>();

     list(): string[] {
          return Array.from(this.active.keys());
     }

     isMonitored(folderName: string): boolean {
          return this.active.has(folderName);
     }

     enable(folderName: string): void {
          if (this.active.has(folderName)) {
               return;
          }

          const folder = folderRegistry.getFolderByName(folderName);
          if (!folder) {
               throw new Error(`Folder ${folderName} is not registered.`);
          }

          const folderRecord = db.select({ id: folders.id }).from(folders).where(eq(folders.name, folderName)).get();
          if (!folderRecord) {
               throw new Error(`Folder ${folderName} not found in database.`);
          }

          merkleMonitor.registerFolder(folder);

          const unsubscribe = merkleMonitor.subscribe(folderName, ({ diff }) => {
               this.logDagChange(folderRecord.id, diff);
          });

          this.active.set(folderName, { unsubscribe, folderId: folderRecord.id });
     }

     disable(folderName: string): void {
          const handle = this.active.get(folderName);
          if (!handle) {
               return;
          }

          handle.unsubscribe();
          this.active.delete(folderName);
     }

     private logDagChange(folderId: number, diff: MerkleDiff): void {
          try {
               const filesToIndex = [...diff.changedFiles, ...diff.addedFiles];
               for (const filePath of filesToIndex) {
                    db.insert(monitorEvents)
                         .values({
                              folderId,
                              filePath,
                              needsIndexed: true,
                         })
                         .run();
               }
          } catch (error) {
               console.error(`[monitoring] Unable to log DAG change for folder ${folderId}:`, error);
          }
     }
}

const monitorService = new MonitorService();
export default monitorService;
