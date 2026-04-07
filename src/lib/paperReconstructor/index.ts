import type { OCRDocument, OCRPage, OCRBlock } from "@/lib/embed/paperProcess";
import { parseReferences } from "@/lib/citations/parseReferences";
import { spawn } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import configManager from "@/server/index";
import db from "@/server/db";
import { extractedFigures } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

interface BBox {
     x0: number;
     y0: number;
     x1: number;
     y1: number;
}

interface FigureRegion {
     pageIndex: number;
     bbox: BBox;
     pageWidth: number;
     pageHeight: number;
     /** Position in the document (page index * 10000 + block order) for ordering */
     docOrder: number;
     /** Caption text from an adjacent figure_title block, if found */
     caption: string;
}

interface ExtractedFigure {
     filename: string;
     caption: string;
     docOrder: number;
}

export interface FigureEntry {
     filename: string;
     caption: string;
     pageIndex: number;
     docOrder: number;
}

export interface ReconstructedSections {
     mainText: string;
     methods: string | null;
     references: string;
     figureCaptions: string;
     figures: FigureEntry[];
}

// ── Union-Find clustering (ported from upload/route.ts) ──────────────────────

function unionBboxes(boxes: BBox[]): BBox {
     return {
          x0: Math.min(...boxes.map((b) => b.x0)),
          y0: Math.min(...boxes.map((b) => b.y0)),
          x1: Math.max(...boxes.map((b) => b.x1)),
          y1: Math.max(...boxes.map((b) => b.y1)),
     };
}

function totalArea(boxes: BBox[]): number {
     return boxes.reduce((s, b) => s + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
}

function bboxArea(b: BBox): number {
     return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

/** Fraction of block `a` that is overlapped by box `b` (0–1). */
function overlapFraction(a: BBox, b: BBox): number {
     const area = bboxArea(a);
     if (area <= 0) return 0;
     const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
     const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
     return (ix * iy) / area;
}

/**
 * Returns true if the block's bbox overlaps any of the given image/chart
 * bboxes by more than `threshold` fraction of the block's area.
 * Used to filter text embedded inside figures (panel labels, axis titles, etc.).
 */
function isInsideFigure(blockBbox: BBox, figureBboxes: BBox[], threshold = 0.3): boolean {
     return figureBboxes.some((fig) => overlapFraction(blockBbox, fig) > threshold);
}

function clusterBboxes(boxes: BBox[], margin: number, vertGap: number): BBox[][] {
     const n = boxes.length;
     const parent = Array.from({ length: n }, (_, i) => i);
     const find = (x: number): number => {
          while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
          return x;
     };
     const union = (a: number, b: number) => { parent[find(a)] = find(b); };

     for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
               const a = boxes[i], b = boxes[j];
               const ox = Math.min(a.x1 + margin, b.x1 + margin) - Math.max(a.x0 - margin, b.x0 - margin);
               const oy = Math.min(a.y1 + margin, b.y1 + margin) - Math.max(a.y0 - margin, b.y0 - margin);
               if (ox > 0 && oy > 0) { union(i, j); continue; }
               const hOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
               const hMin = Math.min(a.x1 - a.x0, b.x1 - b.x0);
               const vGap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
               if (vGap >= 0 && vGap < vertGap && hOverlap > 0.1 * hMin) union(i, j);
          }
     }

     const groups = new Map<number, BBox[]>();
     for (let i = 0; i < n; i++) {
          const root = find(i);
          if (!groups.has(root)) groups.set(root, []);
          groups.get(root)!.push(boxes[i]);
     }
     return Array.from(groups.values());
}

// ── Figure extraction via PyMuPDF ────────────────────────────────────────────

/**
 * Batch-extract multiple figure regions from a single PDF.
 * Spawns one Python process for all regions. Stores PNGs as blobs in SQLite.
 */
async function extractFigureRegions(
     pdfPath: string,
     regions: FigureRegion[],
     paperId: number,
): Promise<ExtractedFigure[]> {
     const pdfBasename = path.basename(pdfPath, path.extname(pdfPath));
     const results: ExtractedFigure[] = [];

     // Build extraction jobs, skipping already-cached figures (check DB)
     const jobs: { region: FigureRegion; filename: string; tmpPath: string }[] = [];
     for (let i = 0; i < regions.length; i++) {
          const r = regions[i];
          const filename = `${pdfBasename}_extracted_p${r.pageIndex}_f${i}.png`;

          const cached = db
               .select({ id: extractedFigures.id })
               .from(extractedFigures)
               .where(and(eq(extractedFigures.paperId, paperId), eq(extractedFigures.filename, filename)))
               .get();

          if (cached) {
               results.push({ filename, caption: r.caption, docOrder: r.docOrder });
          } else {
               jobs.push({ region: r, filename, tmpPath: "" }); // tmpPath set below
          }
     }

     if (jobs.length === 0) return results;

     // Extract to a temp directory, then read bytes into DB
     const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-fig-batch-"));

     // Assign temp output paths
     for (const job of jobs) {
          job.tmpPath = path.join(tempDir, job.filename);
     }

     // Build a JSON manifest of regions to extract
     const manifest = jobs.map((j) => ({
          page: j.region.pageIndex,
          nx0: j.region.bbox.x0 / j.region.pageWidth,
          ny0: j.region.bbox.y0 / j.region.pageHeight,
          nx1: j.region.bbox.x1 / j.region.pageWidth,
          ny1: j.region.bbox.y1 / j.region.pageHeight,
          out: j.tmpPath,
     }));

     const pythonScript = `
import fitz, sys, json

pdf_path = sys.argv[1]
manifest = json.loads(sys.argv[2])
doc = fitz.open(pdf_path)

for item in manifest:
    page = doc[item["page"]]
    pw, ph = page.rect.width, page.rect.height
    pad_x = 0.01 * pw
    pad_y = 0.01 * ph
    clip = fitz.Rect(
        max(0,  item["nx0"] * pw - pad_x),
        max(0,  item["ny0"] * ph - pad_y),
        min(pw, item["nx1"] * pw + pad_x),
        min(ph, item["ny1"] * ph + pad_y),
    )
    pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=clip)
    pix.save(item["out"])

print("EXTRACTED_ALL")
`.trimStart();

     const scriptPath = path.join(tempDir, "batch_crop.py");
     fs.writeFileSync(scriptPath, pythonScript);

     const pythonExe: string = configManager.getConfig("preferences.pythonPath", "python") || "python";

     try {
          await new Promise<void>((resolve, reject) => {
               const proc = spawn(
                    pythonExe,
                    [scriptPath, pdfPath, JSON.stringify(manifest)],
                    { cwd: tempDir, env: process.env },
               );
               let stderr = "";
               proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
               proc.on("close", (code) => {
                    if (code !== 0) reject(new Error(`Figure batch extraction failed (exit ${code}): ${stderr.slice(0, 800)}`));
                    else resolve();
               });
               proc.on("error", reject);
          });
     } catch (err) {
          console.error("[PaperReconstructor] Figure extraction failed:", err);
          return results;
     }

     // Read extracted PNGs and store as blobs in DB
     for (const job of jobs) {
          if (fs.existsSync(job.tmpPath)) {
               const imageData = fs.readFileSync(job.tmpPath);
               db.insert(extractedFigures)
                    .values({
                         paperId,
                         filename: job.filename,
                         pageIndex: job.region.pageIndex,
                         docOrder: job.region.docOrder,
                         caption: job.region.caption,
                         imageData,
                    })
                    .onConflictDoNothing()
                    .run();
               results.push({ filename: job.filename, caption: job.region.caption, docOrder: job.region.docOrder });
          }
     }

     // Clean up temp directory
     try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

     return results;
}

// ── PaperReconstructor class ─────────────────────────────────────────────────

const METHODS_HEADING_PATTERNS = [
     /^methods$/i,
     /^materials?\s+and\s+methods$/i,
     /^methods?\s+and\s+materials?$/i,
     /^experimental$/i,
     /^experimental\s+section$/i,
     /^experimental\s+methods?$/i,
     /^materials?$/i,
     /^methodology$/i,
     /^procedures?$/i,
     /^computational\s+methods?$/i,
     /^experimental\s+procedures?$/i,
     /^synthesis$/i,
     /^characterization$/i,
];

const REFERENCES_HEADING_PATTERNS = [
     /^references$/i,
     /^bibliography$/i,
     /^works\s+cited$/i,
     /^literature\s+cited$/i,
];

function isMethodsHeading(text: string): boolean {
     const trimmed = text.trim();
     return METHODS_HEADING_PATTERNS.some((p) => p.test(trimmed));
}

function isReferencesHeading(text: string): boolean {
     const trimmed = text.trim();
     return REFERENCES_HEADING_PATTERNS.some((p) => p.test(trimmed));
}

/** Detect figure captions mislabeled as "text" by OCR.
 *  Matches "Figure 1.", "Figure 1:", "Fig. 1 |", "Fig. 1.", etc. */
const FIGURE_CAPTION_RE = /^(Figure|Fig\.)\s*\d+\s*[.|:]/i;

/** Detect figure sub-panel descriptions mislabeled as "text" by OCR.
 *  Matches patterns like "(A) ...", "(B) ...", "(C and D) ...", "(D-G) ...",
 *  and also lowercase comma-separated style: "a, ...", "b, ..." */
const FIGURE_PANEL_RE = /^(\([A-Z](\s*([-–]|and|to)\s*[A-Z])?\)\s|[a-z],\s)/;

function isFigureCaption(text: string): boolean {
     return FIGURE_CAPTION_RE.test(text.trim());
}

function isFigurePanelDescription(text: string): boolean {
     return FIGURE_PANEL_RE.test(text.trim());
}

/**
 * Pre-scan all pages to find short text strings that repeat near the top or
 * bottom of multiple pages — these are header/footer noise that the OCR engine
 * mislabeled (e.g. "Cell Systems", "Article", journal citation lines).
 *
 * Returns a Set of normalised strings to skip during reconstruction.
 */
function detectRepeatedHeaderFooter(
     pages: OCRPage[],
     /** Fraction of page height considered "near top" or "near bottom" */
     edgeFraction = 0.12,
     /** Maximum character length to consider a candidate */
     maxLen = 120,
     /** Minimum number of pages a string must appear on to be treated as noise */
     minPages = 3,
): Set<string> {
     // Map normalised text → set of page indices it appears on
     const occurrences = new Map<string, Set<number>>();

     for (const page of pages) {
          const pageIndex = page.data?.page_index ?? page.page ?? 0;
          const pageHeight = page.data?.height ?? 1;
          const topThreshold = edgeFraction * pageHeight;
          const bottomThreshold = (1 - edgeFraction) * pageHeight;
          const blocks = page.data?.parsing_res_list ?? [];

          for (const block of blocks) {
               // Label-agnostic: position + repetition is sufficient signal
               const content = (block.block_content ?? "").trim();
               if (!content || content.length > maxLen) continue;

               const bbox = block.block_bbox;
               if (!bbox || bbox.length < 4) continue;
               const y0 = bbox[1] as number;
               const y1 = bbox[3] as number;

               // Block must sit near the top or bottom edge of the page
               if (y0 > topThreshold && y1 < bottomThreshold) continue;

               const key = content.toLowerCase().replace(/\s+/g, " ");
               if (!occurrences.has(key)) occurrences.set(key, new Set());
               occurrences.get(key)!.add(pageIndex);
          }
     }

     const skipSet = new Set<string>();
     for (const [key, pageSet] of occurrences) {
          if (pageSet.size >= minPages) skipSet.add(key);
     }
     return skipSet;
}

export class PaperReconstructor {
     private ocrDoc: OCRDocument;
     private pdfPath: string;
     private paperId: number;
     private headerFooterNoise: Set<string> | null = null;

     constructor(ocrDoc: OCRDocument, pdfPath: string, paperId: number) {
          this.ocrDoc = ocrDoc;
          this.pdfPath = pdfPath;
          this.paperId = paperId;
     }

     /** Lazily compute and cache the header/footer noise set */
     private getHeaderFooterNoise(): Set<string> {
          if (!this.headerFooterNoise) {
               this.headerFooterNoise = detectRepeatedHeaderFooter(this.ocrDoc.pages);
          }
          return this.headerFooterNoise;
     }

     /** Check whether a block's content matches detected header/footer noise */
     private isHeaderFooterNoise(content: string): boolean {
          const key = content.trim().toLowerCase().replace(/\s+/g, " ");
          return this.getHeaderFooterNoise().has(key);
     }

     /**
      * Reconstruct the OCR document into rich Markdown, preserving document order.
      * Figures are extracted as PNGs and referenced via the API endpoint.
      */
     async reconstruct(): Promise<string> {
          const parts: { docOrder: number; markdown: string }[] = [];
          const figureRegions: FigureRegion[] = [];

          for (const page of this.ocrDoc.pages) {
               const pageIndex = page.data?.page_index ?? page.page ?? 0;
               const pageWidth = page.data?.width ?? 1;
               const pageHeight = page.data?.height ?? 1;
               const blocks = page.data?.parsing_res_list ?? [];

               // First pass: collect figure regions for batch extraction
               // and find caption associations
               const captionMap = this.buildCaptionMap(blocks, pageIndex);

               // Track which blocks are image/chart for figure grouping
               const visualBlocks: { index: number; bbox: BBox }[] = [];
               for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i];
                    if (!["image", "chart"].includes(block.block_label)) continue;
                    const b = block.block_bbox;
                    if (!b || b.length < 4) continue;
                    visualBlocks.push({ index: i, bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] } });
               }

               // Cluster visual blocks into figure groups
               if (visualBlocks.length > 0) {
                    const margin = Math.min(30, 0.015 * pageHeight);
                    const clusters = clusterBboxes(visualBlocks.map((v) => v.bbox), margin, 40);

                    for (const cluster of clusters) {
                         const union = unionBboxes(cluster);
                         const area = totalArea(cluster);
                         // Skip tiny visual artifacts (< 1% of page area)
                         if (area < 0.01 * pageWidth * pageHeight) continue;

                         // Find the closest figure_title caption for this cluster
                         const caption = captionMap.find((c) =>
                              c.pageIndex === pageIndex &&
                              Math.abs(c.bbox.y0 - union.y1) < 0.15 * pageHeight
                         );

                         const docOrder = pageIndex * 10000 + Math.round(union.y0);
                         figureRegions.push({
                              pageIndex,
                              bbox: union,
                              pageWidth,
                              pageHeight,
                              docOrder,
                              caption: caption?.text ?? "",
                         });
                    }
               }

               // Collect figure bboxes on this page for in-figure text filtering
               const pageFigureBboxes = visualBlocks.map((v) => v.bbox);

               // Second pass: build markdown for text-based blocks
               for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i];
                    const content = (block.block_content ?? "").trim();
                    if (content && this.isHeaderFooterNoise(content)) continue;

                    // Skip text embedded inside figure regions (panel labels, axis text, etc.)
                    const b = block.block_bbox;
                    if (b && b.length >= 4) {
                         const blockBox: BBox = { x0: b[0], y0: b[1], x1: b[2], y1: b[3] };
                         if (isInsideFigure(blockBox, pageFigureBboxes)) continue;
                    }

                    const docOrder = pageIndex * 10000 + i;
                    const md = this.renderBlock(block, docOrder);
                    if (md) parts.push(md);
               }
          }

          // Extract all figures in one batch
          const extractedFigs = await extractFigureRegions(this.pdfPath, figureRegions, this.paperId);

          // Insert extracted figures into the parts array
          for (const fig of extractedFigs) {
               const imgUrl = `/api/papers/${this.paperId}/extracted-figure/${encodeURIComponent(fig.filename)}`;
               let md = `\n![${fig.caption || "Figure"}](${imgUrl})\n`;
               if (fig.caption) {
                    md += `\n*${fig.caption}*\n`;
               }
               parts.push({ docOrder: fig.docOrder, markdown: md });
          }

          // Sort everything by document order and join
          parts.sort((a, b) => a.docOrder - b.docOrder);
          let markdown = parts.map((p) => p.markdown).join("\n");

          // Append parsed references section
          const refs = parseReferences(this.ocrDoc);
          if (refs.length > 0) {
               markdown += "\n\n## References\n";
               for (const ref of refs) {
                    markdown += `\n${ref.refNum}. ${ref.text}\n`;
               }
          }

          return markdown;
     }

     /**
      * Reconstruct the OCR document into four distinct sections for database storage.
      * - mainText: title, abstract, body text (including figure captions, tables, formulas)
      * - methods: content under Methods/Materials/Experimental headings (null if none found)
      * - references: parsed reference list as numbered Markdown
      * - figures: extracted figure PNGs with captions as structured data
      */
     async reconstructSections(): Promise<ReconstructedSections> {
          const mainParts: { docOrder: number; markdown: string }[] = [];
          const methodsParts: { docOrder: number; markdown: string }[] = [];
          const figureCaptionParts: { docOrder: number; markdown: string }[] = [];
          const figureRegions: FigureRegion[] = [];

          let inMethodsSection = false;
          let inReferencesSection = false;

          for (const page of this.ocrDoc.pages) {
               const pageIndex = page.data?.page_index ?? page.page ?? 0;
               const pageWidth = page.data?.width ?? 1;
               const pageHeight = page.data?.height ?? 1;
               const blocks = page.data?.parsing_res_list ?? [];

               // Collect figure regions (same as reconstruct())
               const captionMap = this.buildCaptionMap(blocks, pageIndex);
               const visualBlocks: { index: number; bbox: BBox }[] = [];
               for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i];
                    if (!["image", "chart"].includes(block.block_label)) continue;
                    const b = block.block_bbox;
                    if (!b || b.length < 4) continue;
                    visualBlocks.push({ index: i, bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] } });
               }

               if (visualBlocks.length > 0) {
                    const margin = Math.min(30, 0.015 * pageHeight);
                    const clusters = clusterBboxes(visualBlocks.map((v) => v.bbox), margin, 40);
                    for (const cluster of clusters) {
                         const union = unionBboxes(cluster);
                         const area = totalArea(cluster);
                         if (area < 0.01 * pageWidth * pageHeight) continue;
                         const caption = captionMap.find((c) =>
                              c.pageIndex === pageIndex &&
                              Math.abs(c.bbox.y0 - union.y1) < 0.15 * pageHeight
                         );
                         const docOrder = pageIndex * 10000 + Math.round(union.y0);
                         figureRegions.push({ pageIndex, bbox: union, pageWidth, pageHeight, docOrder, caption: caption?.text ?? "" });
                    }
               }

               // Collect figure bboxes on this page for in-figure text filtering
               const pageFigureBboxes = visualBlocks.map((v) => v.bbox);

               // Second pass: route text blocks to mainText or methods
               for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i];
                    const docOrder = pageIndex * 10000 + i;
                    const content = (block.block_content ?? "").trim();

                    // Skip repeated header/footer noise mislabeled as text
                    if (content && this.isHeaderFooterNoise(content)) continue;

                    // Skip text embedded inside figure regions (panel labels, axis text, etc.)
                    const bb = block.block_bbox;
                    if (bb && bb.length >= 4) {
                         const blockBox: BBox = { x0: bb[0], y0: bb[1], x1: bb[2], y1: bb[3] };
                         if (isInsideFigure(blockBox, pageFigureBboxes)) continue;
                    }

                    // Detect section transitions on paragraph_title blocks
                    if (block.block_label === "paragraph_title" && content) {
                         if (isReferencesHeading(content)) {
                              inReferencesSection = true;
                              inMethodsSection = false;
                              continue; // Skip the heading itself; references come from parseReferences()
                         }
                         if (isMethodsHeading(content)) {
                              inMethodsSection = true;
                              inReferencesSection = false;
                         } else if (inMethodsSection) {
                              // A non-methods heading ends the methods section
                              inMethodsSection = false;
                         }
                         if (inReferencesSection) continue;
                    }

                    // Skip blocks in the references zone (handled separately)
                    if (inReferencesSection) continue;
                    if (block.block_label === "reference_content") continue;

                    // Figure captions go to their own section (separate from mainText)
                    if (block.block_label === "figure_title" && content) {
                         figureCaptionParts.push({ docOrder, markdown: `\n*${content}*\n` });
                         continue;
                    }

                    // Full figure captions (e.g. "Fig. 1 | ...", "Figure 2. ...")
                    // and sub-panel descriptions (e.g. "(A) ...", "a, ...")
                    // are often mislabeled as "text" or "vision_footnote" by OCR
                    if (content && (isFigureCaption(content) || isFigurePanelDescription(content))) {
                         figureCaptionParts.push({ docOrder, markdown: `\n${content}\n` });
                         continue;
                    }

                    const md = this.renderBlock(block, docOrder);
                    if (!md) continue;

                    if (inMethodsSection) {
                         methodsParts.push(md);
                    } else {
                         mainParts.push(md);
                    }
               }
          }

          // Extract figures
          const extractedFigs = await extractFigureRegions(this.pdfPath, figureRegions, this.paperId);

          // // Insert figures into mainText for inline rendering (same as reconstruct())
          // for (const fig of extractedFigs) {
          //      const imgUrl = `/api/papers/${this.paperId}/extracted-figure/${encodeURIComponent(fig.filename)}`;
          //      let md = `\n![${fig.caption || "Figure"}](${imgUrl})\n`;
          //      if (fig.caption) {
          //           md += `\n*${fig.caption}*\n`;
          //      }
          //      mainParts.push({ docOrder: fig.docOrder, markdown: md });
          // }

          // Build mainText
          mainParts.sort((a, b) => a.docOrder - b.docOrder);
          const mainText = mainParts.map((p) => p.markdown).join("\n");

          // Build methods (null if no methods section found)
          let methods: string | null = null;
          if (methodsParts.length > 0) {
               methodsParts.sort((a, b) => a.docOrder - b.docOrder);
               methods = methodsParts.map((p) => p.markdown).join("\n");
          }

          // Build figure captions
          figureCaptionParts.sort((a, b) => a.docOrder - b.docOrder);
          const figureCaptions = figureCaptionParts.map((p) => p.markdown).join("\n");

          // Build references
          const refs = parseReferences(this.ocrDoc);
          let references = "";
          if (refs.length > 0) {
               references = refs.map((ref) => `${ref.refNum}. ${ref.text}`).join("\n");
          }

          // Build figures list
          const figures: FigureEntry[] = extractedFigs.map((fig) => {
               const region = figureRegions.find((r) => r.docOrder === fig.docOrder);
               return {
                    filename: fig.filename,
                    caption: fig.caption,
                    pageIndex: region?.pageIndex ?? 0,
                    docOrder: fig.docOrder,
               };
          });

          return { mainText, methods, references, figureCaptions, figures };
     }

     /**
      * Build a map of figure_title captions on a page for associating with figure clusters.
      */
     private buildCaptionMap(
          blocks: OCRBlock[],
          pageIndex: number,
     ): { pageIndex: number; bbox: BBox; text: string }[] {
          const captions: { pageIndex: number; bbox: BBox; text: string }[] = [];
          for (const block of blocks) {
               if (block.block_label !== "figure_title") continue;
               const content = (block.block_content ?? "").trim();
               if (!content) continue;
               const b = block.block_bbox;
               if (!b || b.length < 4) continue;
               captions.push({
                    pageIndex,
                    bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] },
                    text: content,
               });
          }
          return captions;
     }

     /**
      * Render a single OCR block to Markdown based on its label.
      */
     private renderBlock(block: OCRBlock, docOrder: number): { docOrder: number; markdown: string } | null {
          const content = (block.block_content ?? "").trim();
          if (!content) return null;

          switch (block.block_label) {
               case "paragraph_title":
                    return { docOrder, markdown: `\n## ${content}\n` };

               case "doc_title":
                    return { docOrder, markdown: `\n# ${content}\n` };

               case "abstract":
                    return { docOrder, markdown: `\n*${content}*\n` };

               case "text":
                    return { docOrder, markdown: `\n${content}\n` };

               case "display_formula":
                    // OCR content already includes $$...$$ delimiters
                    if (content.startsWith("$$")) {
                         return { docOrder, markdown: `\n${content}\n` };
                    }
                    return { docOrder, markdown: `\n$$${content}$$\n` };

               case "table":
                    return this.renderTable(content, docOrder);

               case "figure_title":
                    // Rendered alongside extracted figure images; skip standalone
                    // unless there's no associated image block
                    return null;

               // Skip non-content blocks
               case "header":
               case "footer":
               case "number":
               case "formula_number":
               case "reference_content":
               case "vision_footnote":
                    return null;

               default:
                    return null;
          }
     }

     /**
      * Render a table block. OCR tables come as HTML <table> tags.
      * We pass them through directly since the chat UI supports HTML rendering.
      * For tables that contain LaTeX math (e.g. $ \mathring{A} $), the math
      * delimiters are preserved and will be rendered by KaTeX in the UI.
      */
     private renderTable(content: string, docOrder: number): { docOrder: number; markdown: string } {
          // The OCR already provides well-structured HTML tables.
          // Wrap in a div for styling control.
          return {
               docOrder,
               markdown: `\n<div class="paper-table">\n\n${content}\n\n</div>\n`,
          };
     }
}
