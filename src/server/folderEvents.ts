import { EventEmitter } from "node:events";

/**
 * Event emitter for folder-related changes.
 * Used to push updates to SSE clients instead of polling.
 * Uses globalThis to guarantee a single shared instance across
 * all Next.js module scopes (Turbopack / HMR can duplicate modules).
 */
class FolderEventEmitter extends EventEmitter {
     constructor() {
          super();
          this.setMaxListeners(100); // Allow many concurrent SSE connections
     }

     /**
      * Emit a folder change event to notify all listeners.
      * Call this whenever folders are added, removed, or modified.
      */
     notifyChange(): void {
          this.emit("change");
     }
}

const GLOBAL_KEY = Symbol.for("gofetch.folderEvents");
const g = globalThis as Record<symbol, unknown>;
if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new FolderEventEmitter();

const folderEvents = g[GLOBAL_KEY] as FolderEventEmitter;

export default folderEvents;
