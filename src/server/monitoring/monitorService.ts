import { eq } from "drizzle-orm";

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

     enable(folderName: string, rootPath: string): void {
          if (this.active.has(folderName)) {
               return;
          }

          if (!rootPath) {
               throw new Error(`Folder ${folderName} is missing a root path for monitoring.`);
          }

          const folderRecord = db.select({ id: folders.id }).from(folders).where(eq(folders.name, folderName)).get();
          if (!folderRecord) {
               throw new Error(`Folder ${folderName} not found in database.`);
          }

          merkleMonitor.registerFolder({ name: folderName, rootPath });

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
               // Guard against race conditions where folder was deleted during polling
               const folderExists = db.select({ id: folders.id }).from(folders).where(eq(folders.id, folderId)).get();

               if (!folderExists) {
                    return;
               }

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
