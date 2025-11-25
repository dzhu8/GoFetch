import type { FolderRegistration } from "@/server/folderRegistry";

import { buildMerkleDag } from "./dag";
import merkleStore from "./store";
import type { MerkleBuildResult } from "./types";

export function indexFolder(folder: FolderRegistration): MerkleBuildResult {
     const build = buildMerkleDag(folder.rootPath);
     merkleStore.persistBuild(folder.name, folder.rootPath, build);
     return build;
}

export function removeFolderIndex(folderName: string): void {
     merkleStore.removeFolder(folderName);
}
