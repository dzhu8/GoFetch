import { eq } from "drizzle-orm";

import db from "@/server/db";
import { merkleFolders, merkleNodes } from "@/server/db/schema";
import type { MerkleBuildResult, MerkleNode } from "./types";

interface StoredMerkleNode {
     nodePath: string;
     hash: string;
     nodeType: "file" | "directory";
}

class MerkleStore {
     upsertFolderSnapshot(folderName: string, rootPath: string, rootHash: string): number {
          const now = new Date().toISOString();
          const existing = db.select().from(merkleFolders).where(eq(merkleFolders.folderName, folderName)).get();

          if (existing) {
               db.update(merkleFolders)
                    .set({
                         rootHash,
                         rootPath,
                         updatedAt: now,
                    })
                    .where(eq(merkleFolders.id, existing.id))
                    .run();

               return existing.id;
          }

          const result = db
               .insert(merkleFolders)
               .values({
                    folderName,
                    rootPath,
                    rootHash,
                    updatedAt: now,
                    lastCheckedAt: now,
               })
               .run();

          return Number(result.lastInsertRowid);
     }

     replaceNodes(folderId: number, nodes: MerkleNode[]): void {
          db.delete(merkleNodes).where(eq(merkleNodes.folderId, folderId)).run();

          const now = new Date().toISOString();
          const rows = nodes.map((node) => ({
               folderId,
               nodePath: node.path,
               parentPath: node.path === "." ? null : this.getParentPath(node.path),
               nodeType: node.type,
               hash: node.hash,
               size: node.size ?? null,
               metadata: {},
               updatedAt: now,
          }));

          const chunkSize = 200;
          for (let i = 0; i < rows.length; i += chunkSize) {
               const chunk = rows.slice(i, i + chunkSize);
               if (chunk.length === 0) {
                    continue;
               }

               db.insert(merkleNodes).values(chunk).run();
          }
     }

     persistBuild(folderName: string, rootPath: string, build: MerkleBuildResult): number {
          const folderId = this.upsertFolderSnapshot(folderName, rootPath, build.root.hash);
          this.replaceNodes(folderId, Array.from(build.nodes.values()));
          return folderId;
     }

     loadFolder(folderName: string): {
          folderId: number;
          rootHash: string;
          nodes: Map<string, StoredMerkleNode>;
     } | null {
          const folderRow = db.select().from(merkleFolders).where(eq(merkleFolders.folderName, folderName)).get();

          if (!folderRow) {
               return null;
          }

          const nodeRows = db
               .select({
                    nodePath: merkleNodes.nodePath,
                    hash: merkleNodes.hash,
                    nodeType: merkleNodes.nodeType,
               })
               .from(merkleNodes)
               .where(eq(merkleNodes.folderId, folderRow.id))
               .all();

          const nodes = new Map<string, StoredMerkleNode>();
          for (const row of nodeRows) {
               nodes.set(row.nodePath, {
                    nodePath: row.nodePath,
                    hash: row.hash,
                    nodeType: row.nodeType as StoredMerkleNode["nodeType"],
               });
          }

          return {
               folderId: folderRow.id,
               rootHash: folderRow.rootHash,
               nodes,
          };
     }

     removeFolder(folderName: string): void {
          const folderRow = db
               .select({ id: merkleFolders.id })
               .from(merkleFolders)
               .where(eq(merkleFolders.folderName, folderName))
               .get();

          if (!folderRow) {
               return;
          }

          db.delete(merkleFolders).where(eq(merkleFolders.id, folderRow.id)).run();
     }

     touchFolderCheck(folderId: number): void {
          db.update(merkleFolders)
               .set({ lastCheckedAt: new Date().toISOString() })
               .where(eq(merkleFolders.id, folderId))
               .run();
     }

     private getParentPath(relativePath: string): string | null {
          if (relativePath === ".") {
               return null;
          }

          const normalized = relativePath.replace(/\\/g, "/");
          const segments = normalized.split("/");
          segments.pop();

          if (segments.length === 0) {
               return ".";
          }

          return segments.join("/");
     }
}

const merkleStore = new MerkleStore();
export default merkleStore;
export type { StoredMerkleNode };
