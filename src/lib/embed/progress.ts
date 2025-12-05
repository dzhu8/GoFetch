import { EventEmitter } from "node:events";

import type { TaskProgressState } from "./types";
import folderEvents from "@/server/folderEvents";

const states = new Map<string, TaskProgressState>();

const createDefaultState = (folderName: string): TaskProgressState => {
     const now = new Date().toISOString();
     return {
          folderName,
          phase: "idle",
          totalFiles: 0,
          processedFiles: 0,
          startedAt: now,
          updatedAt: now,
     };
};

export const taskProgressEmitter = new EventEmitter();

export function getTaskProgress(folderName: string): TaskProgressState {
     return states.get(folderName) ?? createDefaultState(folderName);
}

export function updateTaskProgress(folderName: string, patch: Partial<TaskProgressState>): TaskProgressState {
     const previous = states.get(folderName) ?? createDefaultState(folderName);
     const startedAt = patch.startedAt ?? previous.startedAt ?? new Date().toISOString();
     const next: TaskProgressState = {
          ...previous,
          ...patch,
          folderName,
          startedAt,
          updatedAt: new Date().toISOString(),
     };

     states.set(folderName, next);
     taskProgressEmitter.emit("update", next);

     // Notify folder SSE clients when task phase changes (for count updates)
     if (patch.phase === "completed" || patch.phase === "error") {
          folderEvents.notifyChange();
     }

     return next;
}

export function clearTaskProgress(folderName: string): void {
     if (states.delete(folderName)) {
          taskProgressEmitter.emit("clear", { folderName });
     }
}
