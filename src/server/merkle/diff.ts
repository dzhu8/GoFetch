import type { MerkleDiff, MerkleNode } from "./types";
import type { StoredMerkleNode } from "./store";

export function diffMerkleNodes(
     previous: Map<string, StoredMerkleNode> | null,
     next: Map<string, MerkleNode>
): MerkleDiff {
     const changedFiles: string[] = [];
     const deletedFiles: string[] = [];
     const addedFiles: string[] = [];

     const prevMap = previous ?? new Map<string, StoredMerkleNode>();

     for (const [path, node] of next.entries()) {
          const prevNode = prevMap.get(path);
          if (!prevNode) {
               if (node.type === "file") {
                    addedFiles.push(path);
               }
               continue;
          }

          if (prevNode.hash !== node.hash && node.type === "file") {
               changedFiles.push(path);
          }
     }

     for (const [path, prevNode] of prevMap.entries()) {
          if (!next.has(path) && prevNode.nodeType === "file") {
               deletedFiles.push(path);
          }
     }

     const hasChanges = changedFiles.length > 0 || deletedFiles.length > 0 || addedFiles.length > 0;

     return {
          changedFiles,
          deletedFiles,
          addedFiles,
          hasChanges,
     };
}
