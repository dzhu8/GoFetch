import { EventEmitter } from "node:events";

/**
 * Event emitter for folder-related changes.
 * Used to push updates to SSE clients instead of polling.
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

const folderEvents = new FolderEventEmitter();

export default folderEvents;
