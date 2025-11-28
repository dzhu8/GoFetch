//@ts-ignore
export type FolderTreeNode = Record<string, FolderTreeNode | null>;

export interface FolderRegistrationLike {
     name: string;
     rootPath: string;
     tree: FolderTreeNode;
}

export type SupportedLanguage = "javascript" | "typescript" | "tsx" | "python" | "rust" | "css" | "html";

export interface SerializedPosition {
     row: number;
     column: number;
}

export interface SerializedNode {
     type: string;
     named: boolean;
     hasError: boolean;
     childCount: number;
     startIndex: number;
     endIndex: number;
     startPosition: SerializedPosition;
     endPosition: SerializedPosition;
     textSnippet?: string;
     truncatedByDepth?: boolean;
     truncatedByChildLimit?: boolean;
     children: SerializedNode[];
}

export interface ASTParseDiagnostics {
     hasError: boolean;
     errorCount: number;
}

export interface ParsedFileAst {
     filePath: string;
     relativePath: string;
     language: SupportedLanguage;
     ast: SerializedNode;
     diagnostics: ASTParseDiagnostics;
}

export interface ParserOptions {
     includeText?: boolean;
     maxDepth?: number;
     maxChildrenPerNode?: number;
     maxTextLength?: number;
     focusNodesOnly?: boolean;
}

export interface FileEntry {
     absolutePath: string;
     relativePath: string;
}
