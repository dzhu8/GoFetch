import fs from "fs";

import Parser from "tree-sitter";

import { detectLanguage, getParser } from "./languages";
import type { FileEntry, ParsedFileAst, ParserOptions, SerializedNode } from "./types";

interface NormalizedParserOptions {
     includeText: boolean;
     maxDepth: number;
     maxChildrenPerNode: number;
     maxTextLength: number;
}

const DEFAULT_OPTIONS: NormalizedParserOptions = {
     includeText: false,
     maxDepth: Number.POSITIVE_INFINITY,
     maxChildrenPerNode: Number.POSITIVE_INFINITY,
     maxTextLength: 512,
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
     parser.reset();
     const tree = parser.parse(source);
     const normalizedOptions = normalizeOptions(options);
     const ast = serializeNode(tree.rootNode, normalizedOptions);

     return {
          filePath: entry.absolutePath,
          relativePath: entry.relativePath,
          language,
          ast,
          diagnostics: {
               hasError: tree.rootNode.hasError,
               errorCount: countErrorNodes(tree.rootNode),
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
     };
}

function serializeNode(node: Parser.SyntaxNode, options: NormalizedParserOptions, depth = 0): SerializedNode {
     const namedChildren = node.namedChildren ?? [];
     const shouldTraverse = depth < options.maxDepth;
     const childLimit = options.maxChildrenPerNode;
     const effectiveLimit = childLimit === Number.POSITIVE_INFINITY ? namedChildren.length : childLimit;
     const children: SerializedNode[] = [];

     if (shouldTraverse) {
          for (let i = 0; i < namedChildren.length && i < effectiveLimit; i += 1) {
               children.push(serializeNode(namedChildren[i], options, depth + 1));
          }
     }

     const truncatedByDepth = !shouldTraverse && namedChildren.length > 0;
     const truncatedByChildLimit = shouldTraverse && namedChildren.length > effectiveLimit;
     const textSnippet = options.includeText ? trimText(node.text, options.maxTextLength) : undefined;

     return {
          type: node.type,
          named: node.isNamed,
          hasError: node.hasError,
          childCount: node.namedChildCount,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          startPosition: { ...node.startPosition },
          endPosition: { ...node.endPosition },
          textSnippet,
          truncatedByDepth: truncatedByDepth || undefined,
          truncatedByChildLimit: truncatedByChildLimit || undefined,
          children,
     };
}

function countErrorNodes(node: Parser.SyntaxNode): number {
     let count = node.isError ? 1 : 0;
     for (const child of node.children ?? []) {
          count += countErrorNodes(child);
     }
     return count;
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