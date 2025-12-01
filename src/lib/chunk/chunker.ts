import fs from "fs";

import configManager from "@/server";
import { detectTextFormat } from "./formats";
import type {
     ChunkedFile,
     ChunkerOptions,
     FileEntry,
     SerializedPosition,
     SupportedTextFormat,
     TextChunk,
} from "./types";

interface NormalizedChunkerOptions {
     maxTokens: number;
     overlapTokens: number;
     preferNaturalBoundaries: boolean;
}

const DEFAULT_OPTIONS: NormalizedChunkerOptions = {
     maxTokens: 1000,
     overlapTokens: 100,
     preferNaturalBoundaries: true,
};

// Approximate characters per token (conservative estimate for English text)
// Most tokenizers average 3-4 chars per token; we use 4 to stay safe
const CHARS_PER_TOKEN = 4;

/**
 * Chunk a single text file into smaller pieces suitable for embedding.
 */
export function chunkFile(entry: FileEntry, options?: ChunkerOptions): ChunkedFile | null {
     const format = detectTextFormat(entry.absolutePath);
     if (!format) {
          return null;
     }

     const content = safeRead(entry.absolutePath);
     if (content === null) {
          return null;
     }

     const normalizedOptions = normalizeOptions(options);
     const chunks = splitIntoChunks(content, normalizedOptions);

     return {
          filePath: entry.absolutePath,
          relativePath: entry.relativePath,
          format,
          chunks,
          totalChunks: chunks.length,
          totalCharacters: content.length,
     };
}

/**
 * Chunk multiple files at once.
 */
export function chunkFiles(entries: FileEntry[], options?: ChunkerOptions): ChunkedFile[] {
     return entries
          .map((entry) => chunkFile(entry, options))
          .filter((result): result is ChunkedFile => result !== null);
}

/**
 * Chunk raw text content directly (useful for testing or custom sources).
 */
export function chunkText(
     content: string,
     format: SupportedTextFormat,
     options?: ChunkerOptions
): Omit<ChunkedFile, "filePath" | "relativePath"> {
     const normalizedOptions = normalizeOptions(options);
     const chunks = splitIntoChunks(content, normalizedOptions);

     return {
          format,
          chunks,
          totalChunks: chunks.length,
          totalCharacters: content.length,
     };
}

function normalizeOptions(options?: ChunkerOptions): NormalizedChunkerOptions {
     // Read from config if not explicitly provided, fall back to hardcoded defaults
     const configMaxTokens = configManager.getConfig("preferences.textChunkMaxTokens", DEFAULT_OPTIONS.maxTokens);
     const configOverlapTokens = configManager.getConfig(
          "preferences.textChunkOverlapTokens",
          DEFAULT_OPTIONS.overlapTokens
     );

     return {
          maxTokens: options?.maxTokens ?? configMaxTokens,
          overlapTokens: options?.overlapTokens ?? configOverlapTokens,
          preferNaturalBoundaries: options?.preferNaturalBoundaries ?? DEFAULT_OPTIONS.preferNaturalBoundaries,
     };
}

function splitIntoChunks(content: string, options: NormalizedChunkerOptions): TextChunk[] {
     if (!content.trim()) {
          return [];
     }

     const maxChars = options.maxTokens * CHARS_PER_TOKEN;
     const overlapChars = options.overlapTokens * CHARS_PER_TOKEN;
     const positions = new PositionLookup(content);
     const chunks: TextChunk[] = [];

     let currentStart = 0;
     let chunkIndex = 0;

     while (currentStart < content.length) {
          // Calculate the end position for this chunk
          let targetEnd = Math.min(currentStart + maxChars, content.length);

          // If we're not at the end and prefer natural boundaries, try to find one
          if (targetEnd < content.length && options.preferNaturalBoundaries) {
               targetEnd = findNaturalBoundary(content, currentStart, targetEnd, maxChars);
          }

          const chunkContent = content.slice(currentStart, targetEnd);
          const tokenCount = estimateTokenCount(chunkContent);
          const truncated = targetEnd < content.length;

          chunks.push({
               index: chunkIndex,
               startIndex: currentStart,
               endIndex: targetEnd,
               startPosition: positions.toPosition(currentStart),
               endPosition: positions.toPosition(targetEnd),
               content: chunkContent,
               tokenCount,
               truncated,
          });

          // Move to the next chunk with overlap
          if (targetEnd >= content.length) {
               break;
          }

          // Calculate next start with overlap
          currentStart = Math.max(currentStart + 1, targetEnd - overlapChars);

          // Ensure we're not starting in the middle of a word
          if (options.preferNaturalBoundaries) {
               currentStart = adjustStartToWordBoundary(content, currentStart);
          }

          chunkIndex++;
     }

     return chunks;
}

/**
 * Find a natural boundary (paragraph, sentence, or line) near the target end.
 */
function findNaturalBoundary(content: string, start: number, targetEnd: number, maxChars: number): number {
     // Search window: look back up to 20% of chunk size for a boundary
     const searchWindow = Math.floor(maxChars * 0.2);
     const searchStart = Math.max(start, targetEnd - searchWindow);

     // Priority 1: Look for paragraph break (double newline)
     const paragraphBreak = content.lastIndexOf("\n\n", targetEnd);
     if (paragraphBreak > searchStart) {
          return paragraphBreak + 2; // Include the newlines
     }

     // Priority 2: Look for sentence end (. ! ? followed by space or newline)
     const sentenceEndRegex = /[.!?][\s\n]/g;
     let lastSentenceEnd = -1;
     let match;

     sentenceEndRegex.lastIndex = searchStart;
     while ((match = sentenceEndRegex.exec(content)) !== null && match.index < targetEnd) {
          lastSentenceEnd = match.index + 1; // Include the punctuation
     }

     if (lastSentenceEnd > searchStart) {
          return lastSentenceEnd;
     }

     // Priority 3: Look for line break
     const lineBreak = content.lastIndexOf("\n", targetEnd);
     if (lineBreak > searchStart) {
          return lineBreak + 1; // Include the newline
     }

     // Priority 4: Look for word boundary (space)
     const wordBreak = content.lastIndexOf(" ", targetEnd);
     if (wordBreak > searchStart) {
          return wordBreak + 1;
     }

     // Fallback: use the target end as-is
     return targetEnd;
}

/**
 * Adjust the start position to begin at a word boundary.
 */
function adjustStartToWordBoundary(content: string, start: number): number {
     // If we're at a whitespace or start of content, we're good
     if (start === 0 || /\s/.test(content[start - 1])) {
          return start;
     }

     // Look forward for the next whitespace
     const nextSpace = content.indexOf(" ", start);
     const nextNewline = content.indexOf("\n", start);

     let boundary = content.length;
     if (nextSpace !== -1) {
          boundary = Math.min(boundary, nextSpace + 1);
     }
     if (nextNewline !== -1) {
          boundary = Math.min(boundary, nextNewline + 1);
     }

     // Don't skip too far (max 50 chars to find a word boundary)
     if (boundary - start > 50) {
          return start;
     }

     return boundary;
}

/**
 * Estimate token count based on character count.
 * This is a rough approximation; actual tokenization depends on the model.
 */
function estimateTokenCount(text: string): number {
     return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Helper class to convert character offsets to line/column positions.
 */
class PositionLookup {
     private readonly lineOffsets: number[] = [0];

     constructor(text: string) {
          for (let i = 0; i < text.length; i++) {
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

function safeRead(filePath: string): string | null {
     try {
          return fs.readFileSync(filePath, "utf8");
     } catch {
          return null;
     }
}
