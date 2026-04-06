import type { OCRDocument, OCRPage, OCRBlock } from "@/lib/embed/paperProcess";
import { parseReferences } from "@/lib/citations/parseReferences";
import { spawn } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import configManager from "@/server/index";

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
 * Spawns one Python process for all regions. Caches PNGs alongside the PDF.
 */
async function extractFigureRegions(
     pdfPath: string,
     regions: FigureRegion[],
): Promise<ExtractedFigure[]> {
     const pdfDir = path.dirname(pdfPath);
     const pdfBasename = path.basename(pdfPath, path.extname(pdfPath));
     const results: ExtractedFigure[] = [];

     // Build extraction jobs, skipping already-cached figures
     const jobs: { region: FigureRegion; filename: string; destPath: string }[] = [];
     for (let i = 0; i < regions.length; i++) {
          const r = regions[i];
          const filename = `${pdfBasename}_extracted_p${r.pageIndex}_f${i}.png`;
          const destPath = path.join(pdfDir, filename);

          if (fs.existsSync(destPath)) {
               results.push({ filename, caption: r.caption, docOrder: r.docOrder });
          } else {
               jobs.push({ region: r, filename, destPath });
          }
     }

     if (jobs.length === 0) return results;

     // Build a JSON manifest of regions to extract
     const manifest = jobs.map((j) => ({
          page: j.region.pageIndex,
          nx0: j.region.bbox.x0 / j.region.pageWidth,
          ny0: j.region.bbox.y0 / j.region.pageHeight,
          nx1: j.region.bbox.x1 / j.region.pageWidth,
          ny1: j.region.bbox.y1 / j.region.pageHeight,
          out: j.destPath,
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

     const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-fig-batch-"));
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
          // Return whatever we have cached; skip failed extractions
          return results;
     } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
     }

     // Collect successfully extracted files
     for (const job of jobs) {
          if (fs.existsSync(job.destPath)) {
               results.push({ filename: job.filename, caption: job.region.caption, docOrder: job.region.docOrder });
          }
     }

     return results;
}

// ── PaperReconstructor class ─────────────────────────────────────────────────

export class PaperReconstructor {
     private ocrDoc: OCRDocument;
     private pdfPath: string;
     private paperId: number;

     constructor(ocrDoc: OCRDocument, pdfPath: string, paperId: number) {
          this.ocrDoc = ocrDoc;
          this.pdfPath = pdfPath;
          this.paperId = paperId;
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

               // Second pass: build markdown for text-based blocks
               for (let i = 0; i < blocks.length; i++) {
                    const block = blocks[i];
                    const docOrder = pageIndex * 10000 + i;
                    const md = this.renderBlock(block, docOrder);
                    if (md) parts.push(md);
               }
          }

          // Extract all figures in one batch
          const extractedFigures = await extractFigureRegions(this.pdfPath, figureRegions);

          // Insert extracted figures into the parts array
          for (const fig of extractedFigures) {
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
