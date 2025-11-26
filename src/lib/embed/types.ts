export type EmbeddingPhase = "idle" | "parsing" | "embedding" | "completed" | "error";

export interface EmbeddingProgressState {
     folderName: string;
     phase: EmbeddingPhase;
     totalFiles: number;
     embeddedFiles: number;
     message?: string;
     error?: string;
     startedAt: string;
     updatedAt: string;
}
