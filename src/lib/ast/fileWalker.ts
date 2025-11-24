import path from "path";

import type { FileEntry, FolderRegistrationLike, FolderTreeNode } from "./types";
import { isSupportedFile } from "./languages";

export function listSupportedFiles(registration: FolderRegistrationLike): FileEntry[] {
     return flattenTree(registration.tree, registration.rootPath)
          .filter(({ absolutePath }) => isSupportedFile(absolutePath));
}

function flattenTree(tree: FolderTreeNode, rootPath: string, prefix = ""): FileEntry[] {
     const entries: FileEntry[] = [];

     for (const [name, child] of Object.entries(tree ?? {})) {
          const relative = prefix ? path.join(prefix, name) : name;
          const absolute = path.join(rootPath, relative);

          if (child === null) {
               entries.push({ absolutePath: absolute, relativePath: relative });
          } else {
               entries.push(...flattenTree(child, rootPath, relative));
          }
     }

     return entries;
}