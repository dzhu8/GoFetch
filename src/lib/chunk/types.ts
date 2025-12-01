export type SupportedTextFormat =
     | "markdown"
     | "text"
     | "json"
     | "yaml"
     | "toml"
     | "xml"
     | "csv"
     | "ini"
     | "log"
     | "env";

export interface FolderTreeNode {
     [key: string]: FolderTreeNode | null;
}

export interface FolderRegistrationLike {
     name: string;
     rootPath: string;
     tree: FolderTreeNode;
}

export interface SerializedPosition {
     row: number;
     column: number;
}

export interface TextChunk {
     /** Unique index within the file (0-based) */
     index: number;
     /** Character offset where the chunk starts */
     startIndex: number;
     /** Character offset where the chunk ends (exclusive) */
     endIndex: number;
     /** Line/column position of chunk start */
     startPosition: SerializedPosition;
     /** Line/column position of chunk end */
     endPosition: SerializedPosition;
     /** The actual text content of the chunk */
     content: string;
     /** Approximate token count for this chunk */
     tokenCount: number;
     /** Whether this chunk was truncated at a boundary */
     truncated: boolean;
}

export interface ChunkedFile {
     filePath: string;
     relativePath: string;
     format: SupportedTextFormat;
     chunks: TextChunk[];
     totalChunks: number;
     totalCharacters: number;
}

export interface ChunkerOptions {
     /** Target token count per chunk (default: 1000) */
     maxTokens?: number;
     /** Overlap in tokens between chunks for context continuity (default: 100) */
     overlapTokens?: number;
     /** Whether to try to split on sentence/paragraph boundaries (default: true) */
     preferNaturalBoundaries?: boolean;
}

export interface FileEntry {
     absolutePath: string;
     relativePath: string;
}
