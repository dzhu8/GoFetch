import { EventEmitter } from "node:events";

import type { EmbeddingProgressState } from "./types";
import folderEvents from "@/server/folderEvents";

const states = new Map<string, EmbeddingProgressState>();

const createDefaultState = (folderName: string): EmbeddingProgressState => {
     const now = new Date().toISOString();
     return {
          folderName,
          phase: "idle",
          totalFiles: 0,
          embeddedFiles: 0,
          startedAt: now,
          updatedAt: now,
     };
};

export const embeddingProgressEmitter = new EventEmitter();

export function getEmbeddingProgress(folderName: string): EmbeddingProgressState {
     return states.get(folderName) ?? createDefaultState(folderName);
}

export function updateEmbeddingProgress(
     folderName: string,
     patch: Partial<EmbeddingProgressState>
): EmbeddingProgressState {
     const previous = states.get(folderName) ?? createDefaultState(folderName);
     const startedAt = patch.startedAt ?? previous.startedAt ?? new Date().toISOString();
     const next: EmbeddingProgressState = {
          ...previous,
          ...patch,
          folderName,
          startedAt,
          updatedAt: new Date().toISOString(),
     };

     states.set(folderName, next);
     embeddingProgressEmitter.emit("update", next);

     // Notify folder SSE clients when embedding phase changes (for count updates)
     if (patch.phase === "completed" || patch.phase === "error") {
          folderEvents.notifyChange();
     }

     return next;
}

export function clearEmbeddingProgress(folderName: string): void {
     if (states.delete(folderName)) {
          embeddingProgressEmitter.emit("clear", { folderName });
     }
}
