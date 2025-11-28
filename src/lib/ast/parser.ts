import fs from "fs";

import type { SyntaxNode } from "@lezer/common";

import { detectLanguage, getParser } from "./languages";
import { filterFocusNodes } from "./focusNodes";
import type {
     FileEntry,
     ParsedFileAst,
     ParserOptions,
     SerializedNode,
     SerializedPosition,
     SupportedLanguage,
} from "./types";

interface NormalizedParserOptions {
     includeText: boolean;
     maxDepth: number;
     maxChildrenPerNode: number;
     maxTextLength: number;
     focusNodesOnly: boolean;
}

const DEFAULT_OPTIONS: NormalizedParserOptions = {
     includeText: false,
     maxDepth: Number.POSITIVE_INFINITY,
     maxChildrenPerNode: Number.POSITIVE_INFINITY,
     maxTextLength: 512,
     focusNodesOnly: true,
};

export function parseFile(entry: FileEntry, options?: ParserOptions): ParsedFileAst | null {
     const language = detectLanguage(entry.absolutePath);
     if (!language) {
          return null;
     }

     const source = safeRead(entry.absolutePath);
     if (source === null) {
          return null;
     }

     const parser = getParser(language);
     const tree = parser.parse(source);
     const normalizedOptions = normalizeOptions(options);
     const positions = new PositionLookup(source);
     const ast = serializeNode(tree.topNode, source, positions, normalizedOptions);
     const filteredAst = normalizedOptions.focusNodesOnly ? filterFocusNodes(ast, language) : ast;
     const errorCount = countErrorNodes(tree.topNode);

     return {
          filePath: entry.absolutePath,
          relativePath: entry.relativePath,
          language,
          ast: filteredAst,
          diagnostics: {
               hasError: errorCount > 0,
               errorCount,
          },
     };
}

export function parseFiles(entries: FileEntry[], options?: ParserOptions): ParsedFileAst[] {
     return entries
          .map((entry) => parseFile(entry, options))
          .filter((result): result is ParsedFileAst => result !== null);
}

function normalizeOptions(options?: ParserOptions): NormalizedParserOptions {
     return {
          includeText: options?.includeText ?? DEFAULT_OPTIONS.includeText,
          maxDepth: options?.maxDepth ?? DEFAULT_OPTIONS.maxDepth,
          maxChildrenPerNode: options?.maxChildrenPerNode ?? DEFAULT_OPTIONS.maxChildrenPerNode,
          maxTextLength: options?.maxTextLength ?? DEFAULT_OPTIONS.maxTextLength,
          focusNodesOnly: options?.focusNodesOnly ?? DEFAULT_OPTIONS.focusNodesOnly,
     };
}

function serializeNode(
     node: SyntaxNode,
     source: string,
     positions: PositionLookup,
     options: NormalizedParserOptions,
     depth = 0
): SerializedNode {
     const namedChildren = collectNamedChildren(node);
     const shouldTraverse = depth < options.maxDepth;
     const childLimit = options.maxChildrenPerNode;
     const effectiveLimit = childLimit === Number.POSITIVE_INFINITY ? namedChildren.length : childLimit;
     const children: SerializedNode[] = [];

     if (shouldTraverse) {
          for (let i = 0; i < namedChildren.length && i < effectiveLimit; i += 1) {
               children.push(serializeNode(namedChildren[i], source, positions, options, depth + 1));
          }
     }

     const truncatedByDepth = !shouldTraverse && namedChildren.length > 0;
     const truncatedByChildLimit = shouldTraverse && namedChildren.length > effectiveLimit;
     const textSnippet = options.includeText
          ? trimText(source.slice(node.from, node.to), options.maxTextLength)
          : undefined;

     return {
          type: node.type.name,
          named: !node.type.isAnonymous,
          hasError: node.type.isError,
          childCount: namedChildren.length,
          startIndex: node.from,
          endIndex: node.to,
          startPosition: positions.toPosition(node.from),
          endPosition: positions.toPosition(node.to),
          textSnippet,
          truncatedByDepth: truncatedByDepth || undefined,
          truncatedByChildLimit: truncatedByChildLimit || undefined,
          children,
     };
}

function countErrorNodes(node: SyntaxNode): number {
     let count = node.type.isError ? 1 : 0;
     for (let child = node.firstChild; child; child = child.nextSibling) {
          count += countErrorNodes(child);
     }
     return count;
}

function collectNamedChildren(node: SyntaxNode): SyntaxNode[] {
     const namedChildren: SyntaxNode[] = [];
     for (let child = node.firstChild; child; child = child.nextSibling) {
          if (!child.type.isAnonymous) {
               namedChildren.push(child);
          }
     }
     return namedChildren;
}

class PositionLookup {
     private readonly lineOffsets: number[] = [0];

     constructor(text: string) {
          for (let i = 0; i < text.length; i += 1) {
               if (text[i] === "\n") {
                    this.lineOffsets.push(i + 1);
               }
          }
     }

     toPosition(index: number): SerializedPosition {
          const lineIndex = this.findLineIndex(index);
          const lineStart = this.lineOffsets[lineIndex] ?? 0;
          return {
               row: lineIndex,
               column: index - lineStart,
          };
     }

     private findLineIndex(index: number): number {
          let low = 0;
          let high = this.lineOffsets.length - 1;

          while (low <= high) {
               const mid = Math.floor((low + high) / 2);
               const offset = this.lineOffsets[mid];

               if (offset === index) {
                    return mid;
               }

               if (offset < index) {
                    low = mid + 1;
               } else {
                    high = mid - 1;
               }
          }

          return Math.max(0, low - 1);
     }
}

function trimText(text: string, limit: number): string {
     if (!Number.isFinite(limit) || text.length <= limit) {
          return text;
     }

     return `${text.slice(0, limit)}...`;
}

function safeRead(filePath: string): string | null {
     try {
          return fs.readFileSync(filePath, "utf8");
     } catch {
          return null;
     }
}
