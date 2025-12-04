import { eq, sql } from "drizzle-orm";
import type { SupportedLanguage } from "@/lib/ast/types";
import { Document } from "@langchain/core/documents";

// Lazy load database to avoid better-sqlite3 being bundled
function getDb() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/db").default;
}
function getSchema() {
     // eslint-disable-next-line @typescript-eslint/no-require-imports
     return require("@/server/db/schema");
}

/** Internal type for AST node query results */
interface AstNodeQueryResult {
     id: number;
     nodeType: string;
     textSnippet: string | null;
     startRow: number;
     startColumn: number;
     endRow: number;
     endColumn: number;
     metadata: unknown;
     filePath: string;
     relativePath: string;
     language: SupportedLanguage;
     folderName: string;
}

/**
 * Represents a code snippet retrieved from the database.
 */
export interface CodeSnippet {
     /** The symbol name that was searched for */
     symbolName: string;
     /** The type of AST node (e.g., function_declaration, class_declaration) */
     nodeType: string;
     /** The file path where the snippet is located */
     filePath: string;
     /** The relative path within the folder */
     relativePath: string;
     /** The programming language of the file */
     language: SupportedLanguage;
     /** The actual code content of the snippet */
     content: string;
     /** Starting line number (1-indexed for display) */
     startLine: number;
     /** Ending line number (1-indexed for display) */
     endLine: number;
     /** Starting column */
     startColumn: number;
     /** Ending column */
     endColumn: number;
}

/**
 * Result of parsing and retrieving snippets.
 */
export interface SnippetRetrievalResult {
     /** Successfully retrieved snippets */
     snippets: CodeSnippet[];
     /** Symbols that were not found in the database */
     notFound: string[];
}

/**
 * Parses symbol names from a `<snippets>` XML block.
 *
 * @param text - The text containing a `<snippets>` block
 * @returns Array of symbol names extracted from the block
 *
 * @example
 * ```typescript
 * const text = `<snippets>
 * login
 * authenticate
 * </snippets>`;
 * const symbols = parseSnippetsTag(text);
 * // ['login', 'authenticate']
 * ```
 */
export function parseSnippetsTag(text: string): string[] {
     const trimmed = text.trim();
     const startTag = "<snippets>";
     const endTag = "</snippets>";

     const startIndex = trimmed.indexOf(startTag);
     const endIndex = trimmed.indexOf(endTag);

     if (startIndex === -1 || endIndex === -1) {
          return [];
     }

     const content = trimmed.slice(startIndex + startTag.length, endIndex).trim();

     // Split by newlines and filter empty lines, trim whitespace and list markers
     const listMarkerRegex = /^(\s*(-|\*|\d+\.\s|\d+\)\s|\u2022)\s*)+/;

     return content
          .split("\n")
          .map((line) => line.replace(listMarkerRegex, "").trim())
          .filter((line) => line.length > 0);
}

/**
 * Retrieves code snippets from the database by symbol name.
 * Searches in AST node metadata for matching symbol names.
 *
 * @param symbolName - The symbol name to search for
 * @param folderName - Optional folder name to restrict the search
 * @returns Array of matching code snippets
 */
export async function retrieveSnippetBySymbol(symbolName: string, folderName?: string): Promise<CodeSnippet[]> {
     // Search for nodes where metadata contains the symbol name
     // The symbolName is stored in the metadata JSON field
     const metadataPattern = `%"symbolName":"${symbolName}"%`;

     const db = getDb();
     const { astNodes, astFileSnapshots } = getSchema();

     let query = db
          .select({
               id: astNodes.id,
               nodeType: astNodes.type,
               textSnippet: astNodes.textSnippet,
               startRow: astNodes.startRow,
               startColumn: astNodes.startColumn,
               endRow: astNodes.endRow,
               endColumn: astNodes.endColumn,
               metadata: astNodes.metadata,
               // Join with file snapshots for file information
               filePath: astFileSnapshots.filePath,
               relativePath: astFileSnapshots.relativePath,
               language: astFileSnapshots.language,
               folderName: astFileSnapshots.folderName,
          })
          .from(astNodes)
          .innerJoin(astFileSnapshots, eq(astNodes.fileId, astFileSnapshots.id))
          .where(sql`json_extract(${astNodes.metadata}, '$.symbolName') = ${symbolName}`);

     const results: AstNodeQueryResult[] = query.all();

     // Filter by folder if specified
     const filteredResults = folderName ? results.filter((r) => r.folderName === folderName) : results;

     return filteredResults.map((row) => ({
          symbolName,
          nodeType: row.nodeType,
          filePath: row.filePath,
          relativePath: row.relativePath,
          language: row.language,
          content: row.textSnippet ?? "",
          startLine: row.startRow + 1, // Convert to 1-indexed
          endLine: row.endRow + 1,
          startColumn: row.startColumn,
          endColumn: row.endColumn,
     }));
}

/**
 * Retrieves multiple code snippets from parsed symbol names.
 *
 * @param symbols - Array of symbol names to retrieve
 * @param folderName - Optional folder name to restrict the search
 * @returns Object containing found snippets and not-found symbols
 */
export async function retrieveSnippets(symbols: string[], folderName?: string): Promise<SnippetRetrievalResult> {
     const snippets: CodeSnippet[] = [];
     const notFound: string[] = [];

     for (const symbol of symbols) {
          const found = await retrieveSnippetBySymbol(symbol, folderName);
          if (found.length > 0) {
               snippets.push(...found);
          } else {
               notFound.push(symbol);
          }
     }

     return { snippets, notFound };
}

/**
 * Parses a `<snippets>` tag and retrieves all matching code snippets.
 * This is the main entry point for the snippet retrieval workflow.
 *
 * @param text - The text containing a `<snippets>` block
 * @param folderName - Optional folder name to restrict the search
 * @returns Object containing found snippets and not-found symbols
 *
 * @example
 * ```typescript
 * const response = `<snippets>
 * handleLogin
 * validateUser
 * </snippets>`;
 *
 * const result = await parseAndRetrieveSnippets(response, 'my-project');
 *
 * for (const snippet of result.snippets) {
 *   console.log(`${snippet.symbolName} in ${snippet.relativePath}:${snippet.startLine}`);
 *   console.log(snippet.content);
 * }
 * ```
 */
export async function parseAndRetrieveSnippets(text: string, folderName?: string): Promise<SnippetRetrievalResult> {
     const symbols = parseSnippetsTag(text);

     if (symbols.length === 0) {
          return { snippets: [], notFound: [] };
     }

     return retrieveSnippets(symbols, folderName);
}

/**
 * Formats a code snippet for display in a markdown code block.
 *
 * @param snippet - The code snippet to format
 * @param includeLocation - Whether to include file location as a comment
 * @returns Formatted markdown code block string
 */
export function formatSnippetAsCodeBlock(snippet: CodeSnippet, includeLocation: boolean = true): string {
     const locationComment = includeLocation
          ? `// ${snippet.relativePath}:${snippet.startLine}-${snippet.endLine}\n`
          : "";

     return `\`\`\`${snippet.language}\n${locationComment}${snippet.content}\n\`\`\``;
}

/**
 * Formats multiple snippets as markdown code blocks.
 *
 * @param snippets - Array of code snippets to format
 * @param includeLocation - Whether to include file locations
 * @returns Formatted markdown string with all snippets
 */
export function formatSnippetsAsCodeBlocks(snippets: CodeSnippet[], includeLocation: boolean = true): string {
     return snippets.map((snippet) => formatSnippetAsCodeBlock(snippet, includeLocation)).join("\n\n");
}

/**
 * Converts a CodeSnippet to a LangChain Document.
 * Stores snippet metadata for later formatting.
 */
export function snippetToDocument(snippet: CodeSnippet): Document {
     return new Document({
          pageContent: snippet.content,
          metadata: {
               type: "code_snippet",
               symbolName: snippet.symbolName,
               nodeType: snippet.nodeType,
               filePath: snippet.filePath,
               relativePath: snippet.relativePath,
               language: snippet.language,
               startLine: snippet.startLine,
               endLine: snippet.endLine,
               startColumn: snippet.startColumn,
               endColumn: snippet.endColumn,
          },
     });
}

/**
 * Parses a `<snippets>` tag and retrieves matching code snippets as Documents.
 * This is the main entry point for use in RAG pipelines.
 *
 * @param text - The text containing a `<snippets>` block
 * @param folderName - Optional folder name to restrict the search
 * @returns Object containing Documents and not-found symbols
 */
export async function getDocumentsFromSnippets(
     text: string,
     folderName?: string
): Promise<{ documents: Document[]; notFound: string[] }> {
     const result = await parseAndRetrieveSnippets(text, folderName);

     return {
          documents: result.snippets.map(snippetToDocument),
          notFound: result.notFound,
     };
}

/**
 * Converts a Document back to a CodeSnippet for formatting.
 * Only works with documents created by snippetToDocument.
 */
export function documentToSnippet(doc: Document): CodeSnippet | null {
     if (doc.metadata?.type !== "code_snippet") {
          return null;
     }

     return {
          symbolName: doc.metadata.symbolName,
          nodeType: doc.metadata.nodeType,
          filePath: doc.metadata.filePath,
          relativePath: doc.metadata.relativePath,
          language: doc.metadata.language as SupportedLanguage,
          content: doc.pageContent,
          startLine: doc.metadata.startLine,
          endLine: doc.metadata.endLine,
          startColumn: doc.metadata.startColumn,
          endColumn: doc.metadata.endColumn,
     };
}

/**
 * Formats Documents containing code snippets as markdown code blocks.
 * For use in postprocessing after RAG retrieval.
 */
export function formatDocumentsAsCodeBlocks(documents: Document[], includeLocation: boolean = true): string {
     const snippets = documents.map(documentToSnippet).filter((s): s is CodeSnippet => s !== null);

     return formatSnippetsAsCodeBlocks(snippets, includeLocation);
}

/**
 * File info structure.
 */
export interface FileInfo {
     filename: string;
     language: string;
}

/**
 * Retrieves code snippets from the database by file path.
 * Searches for AST nodes in files matching the given filename or path.
 *
 * @param fileInfo - File info from FileLinksOutputParser
 * @param folderName - Optional folder name to restrict the search
 * @returns Array of matching code snippets from the file
 */
export async function retrieveSnippetsByFile(fileInfo: FileInfo, folderName?: string): Promise<CodeSnippet[]> {
     // Search for files matching the filename (using LIKE for partial path matching)
     const db = getDb();
     const { astNodes, astFileSnapshots } = getSchema();

     const query = db
          .select({
               id: astNodes.id,
               nodeType: astNodes.type,
               textSnippet: astNodes.textSnippet,
               startRow: astNodes.startRow,
               startColumn: astNodes.startColumn,
               endRow: astNodes.endRow,
               endColumn: astNodes.endColumn,
               metadata: astNodes.metadata,
               filePath: astFileSnapshots.filePath,
               relativePath: astFileSnapshots.relativePath,
               language: astFileSnapshots.language,
               folderName: astFileSnapshots.folderName,
          })
          .from(astNodes)
          .innerJoin(astFileSnapshots, eq(astNodes.fileId, astFileSnapshots.id))
          .where(sql`${astFileSnapshots.relativePath} LIKE ${"%" + fileInfo.filename}`);

     const results: AstNodeQueryResult[] = query.all();

     // Filter by folder if specified
     const filteredResults = folderName ? results.filter((r) => r.folderName === folderName) : results;

     return filteredResults.map((row) => {
          // Extract symbol name from metadata if available
          const metadata = row.metadata as Record<string, unknown> | null;
          const symbolName = typeof metadata?.symbolName === "string" ? metadata.symbolName : row.nodeType;

          return {
               symbolName,
               nodeType: row.nodeType,
               filePath: row.filePath,
               relativePath: row.relativePath,
               language: row.language,
               content: row.textSnippet ?? "",
               startLine: row.startRow + 1,
               endLine: row.endRow + 1,
               startColumn: row.startColumn,
               endColumn: row.endColumn,
          };
     });
}

/**
 * Retrieves documents from file links.
 *
 * @param fileLinks - Array of FileInfo from FileLinksOutputParser
 * @param folderName - Optional folder name to restrict the search
 * @returns Object containing Documents and not-found files
 */
export async function getDocumentsFromFileLinks(
     fileLinks: FileInfo[],
     folderName?: string
): Promise<{ documents: Document[]; notFound: string[] }> {
     const allSnippets: CodeSnippet[] = [];
     const notFound: string[] = [];

     for (const fileInfo of fileLinks) {
          const snippets = await retrieveSnippetsByFile(fileInfo, folderName);
          if (snippets.length > 0) {
               allSnippets.push(...snippets);
          } else {
               notFound.push(fileInfo.filename);
          }
     }

     return {
          documents: allSnippets.map(snippetToDocument),
          notFound,
     };
}
