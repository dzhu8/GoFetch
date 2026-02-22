// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceBlock {
     pageIndex: number;
     blockId: number | null;
     blockOrder: number | null;
     segmentIndex: number;
}

export interface ParsedReference {
     /** 1-based reference number as found in the document */
     refNum: number;
     /** 0-based position in output array */
     index: number;
     /** Fully stitched reference text (stripped of leading numbering) */
     text: string;
     /** Extracted search term: DOI if present, otherwise heuristic title */
     searchTerm: string;
     /** Whether searchTerm is a DOI */
     isDoi: boolean;
     /** Raw fragment texts before join */
     rawFragments: string[];
     /** Provenance: one entry per fragment */
     sourceBlocks: SourceBlock[];
}

export interface DocumentMetadata {
     title: string | null;
     doi: string | null;
}

// ---------------------------------------------------------------------------
// Step 1 – Collect & sort raw blocks from the OCR JSON
// ---------------------------------------------------------------------------

interface RawBlock {
     pageIndex: number;
     blockId: number | null;
     blockOrder: number | null;
     bboxY0: number;
     bboxX0: number;
     content: string;
}

function collectRawBlocks(ocrResult: any): RawBlock[] {
     const raw: RawBlock[] = [];

     if (!ocrResult?.pages) return raw;

     for (const page of ocrResult.pages) {
          const pageIndex: number = page.data?.page_index ?? page.page ?? 0;
          const list = extractParsingResList(page.data);

          for (const block of list) {
               const label: string = block.block_label ?? block.label ?? "";
               if (label !== "reference_content") continue;

               const content: string = normalizeText(
                    block.block_content ?? block.text ?? block.content ?? block.rec_text ?? ""
               );
               if (!content) continue;

               const bbox: number[] = block.block_bbox ?? block.bbox ?? [];
               raw.push({
                    pageIndex,
                    blockId: block.block_id ?? null,
                    blockOrder: block.block_order ?? null,
                    bboxY0: bbox[1] ?? 0,
                    bboxX0: bbox[0] ?? 0,
                    content,
               });
          }
     }

     // Sort by (pageIndex, blockOrder) when present, else (pageIndex, bboxY0, bboxX0)
     raw.sort((a, b) => {
          if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
          if (a.blockOrder !== null && b.blockOrder !== null) return a.blockOrder - b.blockOrder;
          if (a.blockOrder !== null) return -1;
          if (b.blockOrder !== null) return 1;
          if (a.bboxY0 !== b.bboxY0) return a.bboxY0 - b.bboxY0;
          return a.bboxX0 - b.bboxX0;
     });

     return raw;
}

/** Recursively extract parsing_res_list arrays from any nesting level */
function extractParsingResList(data: any): any[] {
     if (!data) return [];
     const results: any[] = [];

     if (Array.isArray(data)) {
          for (const item of data) results.push(...extractParsingResList(item));
          return results;
     }

     if (data.parsing_res_list && Array.isArray(data.parsing_res_list)) {
          results.push(...data.parsing_res_list);
     }
     for (const key of ["res", "result", "parsing_result", "blocks", "children"]) {
          if (data[key]) results.push(...extractParsingResList(data[key]));
     }
     return results;
}

// ---------------------------------------------------------------------------
// Step 2 – Normalize block text
// ---------------------------------------------------------------------------

function normalizeText(t: string): string {
     return t
          .trim()
          .replace(/\r\n/g, "\n")
          .replace(/[ \t]+/g, " ")
          .replace(/ \n/g, "\n")
          .replace(/\n /g, "\n");
}

// ---------------------------------------------------------------------------
// Step 3 – Starter pattern detection
// ---------------------------------------------------------------------------

/**
 * Unified starter regex: optional OCR noise (0-2 non-digit chars), then 1-4
 * digits, then a literal period, then optional whitespace, then optional rest.
 * Captures: [1]=noise, [2]=num, [3]=rest (may be empty/undefined)
 */
const STARTER_RE = /^\s*([^0-9]{0,2}?)(\d{1,4})\.\s*([\s\S]*)$/;

interface StarterMatch {
     refNum: number;
     rest: string;
}

function matchStarter(text: string): StarterMatch | null {
     const m = STARTER_RE.exec(text);
     if (!m) return null;
     return { refNum: parseInt(m[2], 10), rest: m[3].trim() };
}

function isCitationLine(text: string): boolean {
     return /^\s*Citation:\s+\S/i.test(text);
}

// ---------------------------------------------------------------------------
// Step 4 – Split multi-entry blocks
// ---------------------------------------------------------------------------

interface Segment {
     text: string;
     pageIndex: number;
     blockId: number | null;
     blockOrder: number | null;
     segmentIndex: number;
}

function splitMultiEntryBlock(block: RawBlock): Segment[] {
     const lines = block.content.split("\n");

     const starterLineIndices: number[] = [];
     for (let i = 0; i < lines.length; i++) {
          if (matchStarter(lines[i]) !== null) starterLineIndices.push(i);
     }

     if (starterLineIndices.length < 2) {
          return [
               {
                    text: block.content,
                    pageIndex: block.pageIndex,
                    blockId: block.blockId,
                    blockOrder: block.blockOrder,
                    segmentIndex: 0,
               },
          ];
     }

     const segments: Segment[] = [];
     const boundaries = [...starterLineIndices, lines.length];
     for (let s = 0; s < starterLineIndices.length; s++) {
          const from = boundaries[s];
          const to = boundaries[s + 1];
          segments.push({
               text: lines.slice(from, to).join("\n").trim(),
               pageIndex: block.pageIndex,
               blockId: block.blockId,
               blockOrder: block.blockOrder,
               segmentIndex: s,
          });
     }

     // Anything before the first starter is prepended to the first segment
     if (starterLineIndices[0] > 0) {
          const prefix = lines.slice(0, starterLineIndices[0]).join("\n").trim();
          if (prefix) segments[0].text = prefix + "\n" + segments[0].text;
     }

     return segments;
}

// ---------------------------------------------------------------------------
// Step 5 – Join rules
// ---------------------------------------------------------------------------

function joinChunk(current: string, chunk: string): string {
     if (!current) return chunk;
     if (!chunk) return current;

     // De-hyphenate line-wrap: "word-" + "continuation" → "wordcontinuation"
     if (current.endsWith("-") && /^[a-zA-Z]/.test(chunk)) {
          return current.slice(0, -1) + chunk;
     }

     // Don't insert spaces in URL / DOI continuations
     if (/(?:https?:\/\/|doi:|10\.\d{4,})$/.test(current)) {
          return current + chunk;
     }

     return current + " " + chunk;
}

// ---------------------------------------------------------------------------
// Step 6 – Stitching state machine
// ---------------------------------------------------------------------------

interface EntryAccumulator {
     refNum: number;
     textParts: string[];
     rawFragments: string[];
     sourceBlocks: SourceBlock[];
}

function stitchSegments(segments: Segment[]): EntryAccumulator[] {
     const output: EntryAccumulator[] = [];
     let current: EntryAccumulator | null = null;
     const pendingOrphans: Segment[] = [];

     const attachOrphans = (into: EntryAccumulator) => {
          for (const orphan of pendingOrphans) {
               into.rawFragments.unshift(orphan.text);
               into.sourceBlocks.unshift({
                    pageIndex: orphan.pageIndex,
                    blockId: orphan.blockId,
                    blockOrder: orphan.blockOrder,
                    segmentIndex: orphan.segmentIndex,
               });
               into.textParts.unshift(orphan.text);
          }
          pendingOrphans.length = 0;
     };

     for (const seg of segments) {
          const text = seg.text.trim();
          if (!text) continue;

          if (isCitationLine(text)) continue;

          const starter = matchStarter(text);

          if (starter !== null) {
               if (current) output.push(current);

               current = {
                    refNum: starter.refNum,
                    textParts: starter.rest ? [starter.rest] : [],
                    rawFragments: [text],
                    sourceBlocks: [
                         {
                              pageIndex: seg.pageIndex,
                              blockId: seg.blockId,
                              blockOrder: seg.blockOrder,
                              segmentIndex: seg.segmentIndex,
                         },
                    ],
               };

               attachOrphans(current);
          } else {
               if (current) {
                    const lastPart = current.textParts[current.textParts.length - 1] ?? "";
                    const joined = joinChunk(lastPart, text);
                    if (current.textParts.length === 0) {
                         current.textParts.push(joined);
                    } else {
                         current.textParts[current.textParts.length - 1] = joined;
                    }
                    current.rawFragments.push(text);
                    current.sourceBlocks.push({
                         pageIndex: seg.pageIndex,
                         blockId: seg.blockId,
                         blockOrder: seg.blockOrder,
                         segmentIndex: seg.segmentIndex,
                    });
               } else {
                    pendingOrphans.push(seg);
               }
          }
     }

     if (current) output.push(current);

     // Attach any remaining orphans to the last entry
     if (pendingOrphans.length > 0 && output.length > 0) {
          const last = output[output.length - 1];
          for (const orphan of pendingOrphans) {
               last.rawFragments.push(orphan.text);
               last.textParts.push(orphan.text);
               last.sourceBlocks.push({
                    pageIndex: orphan.pageIndex,
                    blockId: orphan.blockId,
                    blockOrder: orphan.blockOrder,
                    segmentIndex: orphan.segmentIndex,
               });
          }
     }

     return output;
}

// ---------------------------------------------------------------------------
// Step 7 – DOI detection
// ---------------------------------------------------------------------------

const DOI_PATTERNS = [
     /https?:\/\/doi\.org\/(10\.\d{4,}\/\S+)/i,
     /\bDOI:\s*(10\.\d{4,}\/\S+)/i,
     /\b(10\.\d{4,}\/\S+)/,
];

const TRAILING_PUNCT = /[.,;:)\]}"']+$/;

function extractDoi(text: string): string | null {
     for (const re of DOI_PATTERNS) {
          const m = re.exec(text);
          if (m) {
               let doi = m[1];
               let prev = "";
               while (doi !== prev) {
                    prev = doi;
                    doi = doi.replace(TRAILING_PUNCT, "");
               }
               return doi;
          }
     }
     return null;
}

// ---------------------------------------------------------------------------
// Step 8 – Title extraction
// ---------------------------------------------------------------------------

/**
 * Journal-prefix pattern: a capitalized word (possibly abbreviated with dots)
 * followed by a volume number and a comma.
 * Examples: "Nature 421, …" / "Rev. Sci. Instrum. 74, …"
 */
const JOURNAL_PREFIX_RE =
     /(?:^|[\s(])([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)*\.?)\s+\d+,/;

/** APA-style "(YYYY)." — title starts right after */
const APA_YEAR_RE = /\(\d{4}\)\.\s+/;

/**
 * Author-list heuristic: runs of "Lastname, I." clusters optionally joined by
 * commas, "&", "and", or "et al."
 */
const AUTHOR_LIST_RE =
     /^(?:[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'-]+,\s*(?:[A-Z]\.[\s]?)+(?:,\s*|&\s*|and\s*)?|et al\.?,?\s*)+/;

export function extractTitle(text: string): string {
     let t = text.replace(/^["""'']+|["""'']+$/g, "").trim();

     // 1. Quoted title anywhere in text
     const quotedMatch = t.match(/["""]([^"""]{10,300})["""]/);
     if (quotedMatch) return quotedMatch[1].trim();

     // 2. APA style: (YYYY). Title. Journal…
     const apaMatch = APA_YEAR_RE.exec(t);
     if (apaMatch) {
          const afterYear = t.slice((apaMatch.index ?? 0) + apaMatch[0].length);
          const end = findTitleEnd(afterYear);
          if (end > 10) return afterYear.slice(0, end).trim();
     }

     // 3. Journal-prefix: title is everything before the journal token
     const journalMatch = JOURNAL_PREFIX_RE.exec(t);
     if (journalMatch) {
          const journalStart = journalMatch.index ?? 0;
          const before = t.slice(0, journalStart).trim();
          const titleCandidate = extractTitleBeforeJournal(before);
          if (titleCandidate && titleCandidate.length > 10) return titleCandidate;
     }

     // 4. Author-list heuristic: skip author block, take next sentence
     const authorMatch = AUTHOR_LIST_RE.exec(t);
     if (authorMatch && authorMatch[0].length > 5) {
          const afterAuthors = t.slice(authorMatch[0].length).trim();
          const yearSkip = /^\(?\d{4}\)?\.\s*/.exec(afterAuthors);
          const body = yearSkip ? afterAuthors.slice(yearSkip[0].length) : afterAuthors;
          const end = findTitleEnd(body);
          if (end > 10) return body.slice(0, end).trim();
     }

     // 5. Period-split fallback
     const parts = t.split(/\.\s+/);
     if (parts.length >= 3) {
          const candidate = parts[1].trim();
          if (candidate.length > 10 && candidate.length < 300) return candidate;
     }
     if (parts.length >= 2) {
          for (const part of parts) {
               const trimmed = part.trim();
               if (trimmed.length > 10 && trimmed.length < 300) return trimmed;
          }
     }

     // 6. Last-resort
     return t.slice(0, 150).trim();
}

function extractTitleBeforeJournal(text: string): string {
     const parts = text.split(/\.\s+/);
     for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i].trim();
          if (p.length > 10 && p.length < 300 && /[a-z]/.test(p)) return p;
     }
     return text.trim();
}

function findTitleEnd(text: string): number {
     const sentenceEnds = [...text.matchAll(/\.\s+/g)];
     for (const m of sentenceEnds) {
          const idx = (m.index ?? 0) + m[0].length;
          const rest = text.slice(idx);
          if (/^[A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]+)*\.?\s+\d/.test(rest)) {
               return m.index ?? 0;
          }
     }
     const firstPeriod = text.indexOf(".");
     return firstPeriod > 10 ? firstPeriod : text.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseReferences(ocrResult: any): ParsedReference[] {
     const rawBlocks = collectRawBlocks(ocrResult);

     const segments: Segment[] = [];
     for (const block of rawBlocks) {
          segments.push(...splitMultiEntryBlock(block));
     }

     const stitched = stitchSegments(segments);

     return stitched
          .map((entry, i) => {
               const stitchedText = entry.textParts.join(" ").trim();
               const doi = extractDoi(stitchedText);
               const searchTerm = doi ? doi : extractTitle(stitchedText);
               return {
                    refNum: entry.refNum,
                    index: i,
                    text: stitchedText,
                    searchTerm,
                    isDoi: doi !== null,
                    rawFragments: entry.rawFragments,
                    sourceBlocks: entry.sourceBlocks,
               } satisfies ParsedReference;
          })
          .filter((ref) => ref.searchTerm.length > 3);
}

/**
 * Extract the DOI and title of the document itself from the OCR output.
 */
export function extractDocumentMetadata(ocrResult: any): DocumentMetadata {
     let title: string | null = null;
     let doi: string | null = null;

     if (!ocrResult?.pages) return { title, doi };

     // Check first 3 pages for title and DOI
     const pagesToCheck = ocrResult.pages.slice(0, 3);

     // 1. Look for explicit doc_title label
     for (const page of pagesToCheck) {
          const list = extractParsingResList(page.data);
          const titleBlocks = list.filter((b) => (b.block_label ?? b.label ?? "") === "doc_title");
          if (titleBlocks.length > 0) {
               title = titleBlocks
                    .map((b) =>
                         normalizeText(b.block_content ?? b.text ?? b.content ?? b.rec_text ?? "")
                    )
                    .join(" ");
               if (title.length > 10) break;
          }
     }

     // 2. Look for DOI
     for (const page of pagesToCheck) {
          const list = extractParsingResList(page.data);
          for (const block of list) {
               const blockContent =
                    block.block_content ?? block.text ?? block.content ?? block.rec_text ?? "";
               const foundDoi = extractDoi(blockContent);
               if (foundDoi) {
                    doi = foundDoi;
                    break;
               }
          }
          if (doi) break;
     }

     return { title, doi };
}
