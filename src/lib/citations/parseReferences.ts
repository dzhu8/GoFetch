export interface ParsedReference {
     index: number;
     text: string;
     title: string;
}

/**
 * Parse OCR JSON output for reference_content blocks and extract paper titles.
 *
 * Traverses all pages in the OCR result and finds blocks whose block_label
 * equals "reference_content".  Leading numbering, OCR-glitched prefixes, and
 * "Citation:" headers are stripped.  Enumerator-only blocks (e.g. just "12.")
 * are stitched with their continuations.
 */
export function parseReferences(ocrResult: any): ParsedReference[] {
     const referenceBlocks: string[] = [];

     if (ocrResult?.pages) {
          for (const page of ocrResult.pages) {
               extractReferenceBlocks(page.data, referenceBlocks);
          }
     }

     const entries = stitchAndClean(referenceBlocks);

     return entries
          .map((text, i) => ({
               index: i,
               text,
               title: extractTitle(text),
          }))
          .filter((ref) => ref.title.length > 3);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractReferenceBlocks(data: any, blocks: string[]): void {
     if (!data) return;

     if (Array.isArray(data)) {
          for (const item of data) {
               extractReferenceBlocks(item, blocks);
          }
          return;
     }

     if (data.block_label === "reference_content" || data.label === "reference_content") {
          const text = data.block_content || data.text || data.content || data.rec_text || "";
          if (text.trim()) {
               blocks.push(text.trim());
          }
     }

     // Recurse into common wrapper keys used by PaddleOCR / PaddleOCR-VL
     if (data.parsing_res_list) extractReferenceBlocks(data.parsing_res_list, blocks);
     if (data.res) extractReferenceBlocks(data.res, blocks);
     if (data.result) extractReferenceBlocks(data.result, blocks);
     if (data.parsing_result) extractReferenceBlocks(data.parsing_result, blocks);
     if (data.blocks) extractReferenceBlocks(data.blocks, blocks);
     if (data.children) extractReferenceBlocks(data.children, blocks);
}

/** Determine whether a block starts a brand-new citation entry. */
function isNewEntry(block: string): boolean {
     // Pattern 1: {number}. followed by text (digits + period + space)
     if (/^\s*\d+\.\s+/.test(block)) return true;

     // Pattern 2: OCR-glitched variant e.g. "§0." — non-digit + digits + period
     if (/^\s*[^\d\s]\d+\./.test(block)) return true;

     // Pattern 3: "Citation:"
     if (/^\s*Citation:/i.test(block)) return true;

     // Pattern 4: Enumerator-only block, e.g. "12."  (starts a new entry whose
     //            body arrives in subsequent block(s))
     if (/^\s*\d{1,4}\.\s*$/.test(block)) return true;

     return false;
}

/** Strip known leading prefixes from a reference block. */
function stripLeading(text: string): string {
     let result = text.trim();

     // "Citation:" prefix
     result = result.replace(/^\s*Citation:\s*/i, "");

     // OCR-glitched numbered prefix: non-digit + digits + period + optional space
     result = result.replace(/^\s*[^\d\s]\d+\.\s*/, "");

     // Normal numbered prefix: digits + period + space
     result = result.replace(/^\s*\d+\.\s+/, "");

     // Standalone enumerator (number only)
     result = result.replace(/^\s*\d{1,4}\.\s*$/, "");

     return result.trim();
}

/**
 * Stitch enumerator-only blocks with their continuations and strip leading
 * characters from each entry.
 */
function stitchAndClean(blocks: string[]): string[] {
     const entries: string[] = [];

     for (const block of blocks) {
          const stripped = stripLeading(block);

          // Enumerator-only block (e.g. "12."): open a new empty entry
          if (/^\s*\d{1,4}\.\s*$/.test(block)) {
               entries.push("");
               continue;
          }

          if (isNewEntry(block)) {
               entries.push(stripped);
          } else {
               // Continuation — append to the previous entry
               if (entries.length > 0) {
                    entries[entries.length - 1] = (entries[entries.length - 1] + " " + stripped).trim();
               } else {
                    entries.push(stripped);
               }
          }
     }

     return entries.filter((e) => e.trim().length > 0);
}

/**
 * Heuristically extract the paper title from a cleaned reference string.
 *
 * Common citation formats:
 *   AuthorA, AuthorB. Paper Title. Journal, Year.
 *   AuthorA et al., "Paper Title", Journal, …
 */
export function extractTitle(text: string): string {
     if (text.length < 200 && !text.includes(".")) return text.trim();

     // Remove surrounding quotes if present
     const unquoted = text.replace(/^["'""]+|["'""]+$/g, "").trim();

     // Check for a quoted title inside the text
     const quotedMatch = unquoted.match(/[""\u201c]([^""\u201d]{10,300})[""\u201d]/);
     if (quotedMatch) return quotedMatch[1].trim();

     // Split on period-space boundaries
     const parts = unquoted.split(/\.\s+/);

     if (parts.length >= 3) {
          // "Authors. Title. Journal…" – title is usually part[1]
          const candidate = parts[1].trim();
          if (candidate.length > 5 && candidate.length < 300) {
               return candidate;
          }
     }

     if (parts.length >= 2) {
          for (const part of parts) {
               const trimmed = part.trim();
               if (trimmed.length > 10 && trimmed.length < 300) {
                    return trimmed;
               }
          }
     }

     // Fallback: first 150 characters
     return text.substring(0, 150).trim();
}
