import type { ChildProcess } from "child_process";

export interface ActiveProcEntry {
     proc: ChildProcess;
     tempDir: string;
}

/**
 * Module-level registry of in-flight PaddleOCR child processes.
 * Keyed by paperId so the DELETE cancel endpoint can look them up.
 */
export const activeProcs = new Map<number, ActiveProcEntry>();
