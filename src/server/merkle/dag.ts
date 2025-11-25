import crypto from "crypto";
import fs from "fs";
import path from "path";

import { IGNORED_DIRECTORY_NAMES, IGNORED_FILE_NAMES } from "@/server/folderIgnore";
import type { MerkleBuildResult, MerkleNode } from "./types";

const ROOT_RELATIVE_PATH = ".";

export function buildMerkleDag(rootPath: string): MerkleBuildResult {
     const absoluteRoot = path.resolve(rootPath);
     const nodes = new Map<string, MerkleNode>();

     const rootNode = buildDirectoryNode(absoluteRoot, ROOT_RELATIVE_PATH, nodes);

     return {
          root: rootNode,
          nodes,
     };
}

function buildDirectoryNode(currentPath: string, relativePath: string, nodes: Map<string, MerkleNode>): MerkleNode {
     const childNodes: MerkleNode[] = [];
     const entries = safeReadDir(currentPath);

     for (const entry of entries) {
          if (shouldIgnoreEntry(entry)) {
               continue;
          }

          const entryAbsolutePath = path.join(currentPath, entry.name);
          const entryRelativePath =
               relativePath === ROOT_RELATIVE_PATH ? entry.name : path.join(relativePath, entry.name);

          if (entry.isDirectory()) {
               const childDirNode = buildDirectoryNode(entryAbsolutePath, entryRelativePath, nodes);
               childNodes.push(childDirNode);
          } else if (entry.isFile()) {
               const fileNode = buildFileNode(entryAbsolutePath, entryRelativePath, nodes);
               childNodes.push(fileNode);
          }
     }

     // Sort child hashes to ensure deterministic ordering regardless of filesystem order
     const sortedChildHashes = childNodes.map((child) => child.hash).sort();
     const directoryHash = hashStrings(["directory", relativePath, ...sortedChildHashes]);

     const node: MerkleNode = {
          path: relativePath,
          hash: directoryHash,
          type: "directory",
          children: childNodes,
     };

     nodes.set(relativePath, node);
     return node;
}

function buildFileNode(filePath: string, relativePath: string, nodes: Map<string, MerkleNode>): MerkleNode {
     const content = safeReadFile(filePath);
     const hash = hashBuffer(content);

     const node: MerkleNode = {
          path: relativePath,
          hash,
          type: "file",
          size: content.length,
          children: [],
     };

     nodes.set(relativePath, node);
     return node;
}

function shouldIgnoreEntry(entry: fs.Dirent): boolean {
     if (entry.isSymbolicLink()) {
          return true;
     }

     if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
          return true;
     }

     if (entry.isFile() && IGNORED_FILE_NAMES.has(entry.name)) {
          return true;
     }

     return false;
}

function safeReadDir(dirPath: string): fs.Dirent[] {
     try {
          return fs.readdirSync(dirPath, { withFileTypes: true });
     } catch (error) {
          console.warn(`[merkle] Failed to read directory ${dirPath}:`, error);
          return [];
     }
}

function safeReadFile(filePath: string): Buffer {
     try {
          return fs.readFileSync(filePath);
     } catch (error) {
          console.warn(`[merkle] Failed to read file ${filePath}:`, error);
          return Buffer.alloc(0);
     }
}

function hashBuffer(buffer: Buffer): string {
     return crypto.createHash("sha256").update(buffer).digest("hex");
}

function hashStrings(parts: string[]): string {
     const hash = crypto.createHash("sha256");
     for (const part of parts) {
          hash.update(part);
     }
     return hash.digest("hex");
}
