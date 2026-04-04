"use server";

import monitorService from "@/server/monitoring/monitorService";
import folderRegistry from "@/server/folderRegistry";

/*
Note this is redundant but remains active for manual control if needed.
*/

export async function getMonitoredFolders() {
     return { monitored: monitorService.list() };
}

export async function setFolderMonitoring(folderName: string, enabled: boolean) {
     try {
          if (!folderName || typeof enabled !== "boolean") {
               return { error: "folderName and enabled are required." };
          }

          if (enabled) {
               const folder = folderRegistry.getFolderByName(folderName);
               if (!folder) {
                    return { error: `Folder ${folderName} is not registered.` };
               }
               monitorService.enable(folderName, folder.rootPath);
          } else {
               monitorService.disable(folderName);
          }

          return { monitored: monitorService.list() };
     } catch (error) {
          console.error("Failed to update monitoring state:", error);
          return { error: error instanceof Error ? error.message : "Failed to update monitoring state." };
     }
}
