export type TaskPhase = "idle" | "parsing" | "summarizing" | "embedding" | "completed" | "error";

export interface TaskProgressState {
     folderName: string;
     phase: TaskPhase;
     totalFiles: number;
     processedFiles: number;
     /** Total tokens output during summarization phase */
     totalTokensOutput?: number;
     message?: string;
     error?: string;
     startedAt: string;
     updatedAt: string;
}
