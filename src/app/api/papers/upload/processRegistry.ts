import type { ChildProcess } from "child_process";

export interface ActiveProcEntry {
     proc: ChildProcess;
     tempDir: string;
}

/**
 * Global registry of in-flight PaddleOCR child processes.
 * Keyed by paperId so the DELETE cancel endpoint can look them up.
 *
 * Uses globalThis + Symbol.for() so the Map is shared across Next.js
 * webpack bundles (API routes vs server actions) and survives HMR
 * re-evaluation — same pattern as the embedding queue in paperProcess.ts.
 */
const GLOBAL_KEY = Symbol.for("gofetch.activeOcrProcs");
const g = globalThis as Record<symbol, unknown>;
if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map<number, ActiveProcEntry>();
export const activeProcs = g[GLOBAL_KEY] as Map<number, ActiveProcEntry>;
