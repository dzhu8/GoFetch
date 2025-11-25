import fs from "fs";
import path from "path";

import type { FileEntry, FolderRegistrationLike } from "./types";
import { isSupportedFile } from "./languages";
import { IGNORED_DIRECTORY_NAMES, IGNORED_FILE_NAMES } from "@/server/folderIgnore";

export function listSupportedFiles(registration: FolderRegistrationLike): FileEntry[] {
     return walkDirectory(registration.rootPath, registration.rootPath);
}

function walkDirectory(currentPath: string, rootPath: string): FileEntry[] {
     const entries: FileEntry[] = [];
     let dirEntries: fs.Dirent[];

     try {
          dirEntries = fs.readdirSync(currentPath, { withFileTypes: true });
     } catch {
          return entries;
     }

     for (const entry of dirEntries) {
          if (shouldIgnore(entry)) {
               continue;
          }

          const fullPath = path.join(currentPath, entry.name);
          const relativePath = path.relative(rootPath, fullPath);
          if (!relativePath) {
               continue;
          }

          if (entry.isDirectory()) {
               entries.push(...walkDirectory(fullPath, rootPath));
          } else if (entry.isFile() && isSupportedFile(fullPath)) {
               entries.push({ absolutePath: fullPath, relativePath });
          }
     }

     return entries;
}

function shouldIgnore(entry: fs.Dirent): boolean {
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
