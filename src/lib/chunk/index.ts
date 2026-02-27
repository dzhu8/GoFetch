import type { FolderRegistrationLike, ChunkedFile, ChunkerOptions } from "./types";
import { listSupportedTextFiles } from "./fileWalker";
import { chunkFiles } from "./chunker";

/**
 * Chunk all supported text files in a folder registration.
 */
export function chunkFolderRegistration(registration: FolderRegistrationLike, options?: ChunkerOptions): ChunkedFile[] {
     const files = listSupportedTextFiles(registration);
     return chunkFiles(files, options);
}

export * from "./types";
export * from "./formats";
export { chunkFiles, chunkFile, chunkText } from "./chunker";
export { listSupportedTextFiles } from "./fileWalker";
