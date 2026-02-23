import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, libraryFolders } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { extractDocumentMetadata } from "@/lib/citations/parseReferences";

export const maxDuration = 300;

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS = "paperId,title,abstract,externalIds,venue,year,authors,citationStyles";

/** Upload a PDF to a folder, run OCR to extract DOI/title, fetch abstract from Semantic Scholar */
export async function POST(req: NextRequest) {
     let tempDir: string | null = null;

     try {
          const formData = await req.formData();
          const pdf = formData.get("pdf") as globalThis.File | null;
          const folderIdStr = formData.get("folderId") as string | null;

          if (!folderIdStr) {
               return NextResponse.json({ error: "folderId is required" }, { status: 400 });
          }

          const folderId = parseInt(folderIdStr, 10);
          if (isNaN(folderId)) {
               return NextResponse.json({ error: "Invalid folderId" }, { status: 400 });
          }

          if (!pdf) {
               return NextResponse.json({ error: "No PDF file provided." }, { status: 400 });
          }

          if (!pdf.name.toLowerCase().endsWith(".pdf")) {
               return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
          }

          // Verify folder exists
          const folder = db.select().from(libraryFolders).where(eq(libraryFolders.id, folderId)).get();
          if (!folder) {
               return NextResponse.json({ error: "Folder not found" }, { status: 404 });
          }

          // Save PDF to the folder's root path
          const sanitizedName = pdf.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const pdfDestPath = path.join(folder.rootPath, sanitizedName);
          const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
          fs.writeFileSync(pdfDestPath, pdfBuffer);

          // Create paper record with "uploading" status
          const paperRow = db
               .insert(papers)
               .values({
                    folderId,
                    fileName: sanitizedName,
                    filePath: pdfDestPath,
                    status: "uploading",
               })
               .returning()
               .get();

          // Return the paper ID immediately, process in background via streaming
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
               async start(controller) {
                    try {
                         controller.enqueue(
                              encoder.encode(
                                   JSON.stringify({ type: "created", paperId: paperRow.id }) + "\n"
                              )
                         );

                         // Update to processing
                         db.update(papers)
                              .set({ status: "processing" })
                              .where(eq(papers.id, paperRow.id))
                              .run();

                         controller.enqueue(
                              encoder.encode(
                                   JSON.stringify({ type: "status", message: "Running OCR..." }) + "\n"
                              )
                         );

                         // Run PaddleOCR extraction
                         tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-paper-ocr-"));
                         const tempPdfPath = path.join(tempDir, "input.pdf");
                         const scriptPath = path.join(tempDir, "run.py");

                         fs.copyFileSync(pdfDestPath, tempPdfPath);
                         fs.writeFileSync(scriptPath, PYTHON_SCRIPT);

                         const env = { ...process.env };
                         const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
                         const cudaPath = process.env.CUDA_PATH;
                         if (cudaPath) {
                              const cudaBin = path.join(cudaPath, "bin");
                              env[pathKey] = `${cudaBin}${path.delimiter}${env[pathKey] ?? ""}`;
                         }

                         const ocrResult = await new Promise<any>((resolve, reject) => {
                              const proc = spawn("python", [scriptPath, tempPdfPath], {
                                   cwd: tempDir!,
                                   env,
                              });

                              let stderrAccum = "";

                              proc.stdout?.on("data", (d: Buffer) => {
                                   const lines = d.toString().split("\n");
                                   for (const line of lines) {
                                        const trimmed = line.trim();
                                        if (trimmed.startsWith("PROGRESS:")) {
                                             const parts = trimmed.split(":");
                                             if (parts[1] === "PAGE") {
                                                  controller.enqueue(
                                                       encoder.encode(
                                                            JSON.stringify({ type: "progress", page: parseInt(parts[2]) }) + "\n"
                                                       )
                                                  );
                                             }
                                        }
                                   }
                              });

                              proc.stderr?.on("data", (d: Buffer) => {
                                   stderrAccum += d.toString();
                              });

                              proc.on("close", (code) => {
                                   if (code !== 0) {
                                        reject(new Error(`PaddleOCR exited with code ${code}: ${stderrAccum.slice(0, 500)}`));
                                   } else {
                                        // Collect page JSONs
                                        const pageFiles = fs
                                             .readdirSync(tempDir!)
                                             .filter((f) => /^page_\d+\.json$/.test(f))
                                             .sort((a, b) => {
                                                  const ai = parseInt(a.match(/\d+/)![0], 10);
                                                  const bi = parseInt(b.match(/\d+/)![0], 10);
                                                  return ai - bi;
                                             });

                                        if (pageFiles.length === 0) {
                                             reject(new Error("OCR produced no output."));
                                             return;
                                        }

                                        const pages = pageFiles.map((f, i) => {
                                             const raw = fs.readFileSync(path.join(tempDir!, f), "utf-8");
                                             try {
                                                  return { page: i, data: JSON.parse(raw) };
                                             } catch {
                                                  return { page: i, data: raw };
                                             }
                                        });

                                        resolve({ source: pdf.name, pages });
                                   }
                              });

                              proc.on("error", reject);
                         });

                         // Extract DOI and title from OCR result
                         const metadata = extractDocumentMetadata(ocrResult);
                         let title = metadata.title;
                         let doi = metadata.doi;

                         controller.enqueue(
                              encoder.encode(
                                   JSON.stringify({ type: "status", message: "Searching Semantic Scholar..." }) + "\n"
                              )
                         );

                         // Try to extract the first figure from OCR pages
                         let firstFigurePath: string | null = null;
                         try {
                              firstFigurePath = await extractFirstFigure(ocrResult, pdfDestPath, folder.rootPath, sanitizedName);
                         } catch (e) {
                              console.warn("[Paper upload] Could not extract first figure:", e);
                         }

                         // Search Semantic Scholar
                         let abstract: string | null = null;
                         let semanticScholarId: string | null = null;
                         let citation: string | null = null;

                         if (doi) {
                              const s2paper = await fetchS2Paper(`DOI:${doi}`);
                              if (s2paper) {
                                   semanticScholarId = s2paper.paperId;
                                   abstract = s2paper.abstract || null;
                                   if (s2paper.title && !title) title = s2paper.title;
                                   citation = formatCitation(s2paper);
                              }
                         }

                         if (!semanticScholarId && title) {
                              const s2paper = await searchS2ByTitle(title);
                              if (s2paper) {
                                   semanticScholarId = s2paper.paperId;
                                   abstract = s2paper.abstract || null;
                                   if (!doi && s2paper.externalIds?.DOI) doi = s2paper.externalIds.DOI;
                                   citation = formatCitation(s2paper);
                              }
                         }

                         // Update paper record
                         db.update(papers)
                              .set({
                                   title: title || sanitizedName.replace(/\.pdf$/i, ""),
                                   doi,
                                   abstract,
                                   semanticScholarId,
                                   semanticScholarCitation: citation,
                                   firstFigurePath,
                                   status: "ready",
                                   updatedAt: new Date().toISOString(),
                              })
                              .where(eq(papers.id, paperRow.id))
                              .run();

                         controller.enqueue(
                              encoder.encode(
                                   JSON.stringify({
                                        type: "complete",
                                        paper: {
                                             id: paperRow.id,
                                             title: title || sanitizedName.replace(/\.pdf$/i, ""),
                                             doi,
                                             abstract,
                                             semanticScholarId,
                                             semanticScholarCitation: citation,
                                             firstFigurePath,
                                             status: "ready",
                                        },
                                   }) + "\n"
                              )
                         );
                         controller.close();
                    } catch (err) {
                         const msg = err instanceof Error ? err.message : "Upload processing failed";
                         console.error("[Paper upload] Error:", err);

                         db.update(papers)
                              .set({ status: "error", updatedAt: new Date().toISOString() })
                              .where(eq(papers.id, paperRow.id))
                              .run();

                         controller.enqueue(
                              encoder.encode(JSON.stringify({ type: "error", message: msg }) + "\n")
                         );
                         controller.close();
                    } finally {
                         if (tempDir) {
                              try {
                                   fs.rmSync(tempDir, { recursive: true, force: true });
                              } catch {}
                         }
                    }
               },
          });

          return new Response(stream, {
               headers: { "Content-Type": "application/x-ndjson" },
          });
     } catch (err) {
          console.error("[Paper upload] initial error:", err);
          const msg = err instanceof Error ? err.message : "Upload failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const PYTHON_SCRIPT = `
import os, sys

if sys.platform == "win32":
    cuda_bin = os.path.join(os.environ.get("CUDA_PATH", ""), "bin")
    if os.path.isdir(cuda_bin):
        os.add_dll_directory(cuda_bin)
        os.environ["PATH"] = cuda_bin + os.pathsep + os.environ.get("PATH", "")

from paddleocr import PaddleOCRVL
import sys
import os

pdf_path = sys.argv[1]
pipeline = PaddleOCRVL()

try:
    import fitz
    doc = fitz.open(pdf_path)
    total = len(doc)
    doc.close()
    print(f"PROGRESS:TOTAL:{total}", flush=True)
except Exception:
    pass

for i, res in enumerate(pipeline.predict(pdf_path)):
    res.save_to_json(f"page_{i}.json")
    print(f"PROGRESS:PAGE:{i+1}", flush=True)
`.trimStart();

async function fetchS2Paper(paperId: string): Promise<any | null> {
     try {
          const res = await fetch(`${S2_BASE}/paper/${encodeURIComponent(paperId)}?fields=${S2_FIELDS}`, {
               headers: { Accept: "application/json" },
               signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return null;
          return await res.json();
     } catch {
          return null;
     }
}

async function searchS2ByTitle(title: string): Promise<any | null> {
     try {
          const params = new URLSearchParams({
               query: title,
               limit: "1",
               fields: S2_FIELDS,
          });
          const res = await fetch(`${S2_BASE}/paper/search?${params}`, {
               headers: { Accept: "application/json" },
               signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return null;
          const data = await res.json();
          return data?.data?.[0] ?? null;
     } catch {
          return null;
     }
}

function formatCitation(paper: any): string {
     const authors = paper.authors?.map((a: any) => a.name) ?? [];
     const authorStr =
          authors.length > 3
               ? `${authors.slice(0, 3).join(", ")} et al.`
               : authors.join(", ");
     const parts = [authorStr, paper.title];
     if (paper.venue) parts.push(paper.venue);
     if (paper.year) parts.push(String(paper.year));
     if (paper.externalIds?.DOI) parts.push(`https://doi.org/${paper.externalIds.DOI}`);
     return parts.filter(Boolean).join(". ") + ".";
}

// ── Figure extraction helpers ─────────────────────────────────────────────────

interface BBox { x0: number; y0: number; x1: number; y1: number }
interface LocatedFigure { page: number; bbox: BBox; pageWidth: number; pageHeight: number }

/** True when `content` is a genuine "Figure N" / "Fig. N" caption. */
function isRealFigureCaption(content: string): boolean {
     return /^(Figure|Fig\.)\s*\d+\b/i.test(content.trim());
}

/** True when `content` is specifically a "Figure 1" / "Fig. 1" caption. */
function isFigureOne(content: string): boolean {
     return /^(Figure|Fig\.)\s*1\b/i.test(content.trim());
}

/** Axis-aligned union of a set of bboxes. */
function unionBboxes(boxes: BBox[]): BBox {
     return {
          x0: Math.min(...boxes.map((b) => b.x0)),
          y0: Math.min(...boxes.map((b) => b.y0)),
          x1: Math.max(...boxes.map((b) => b.x1)),
          y1: Math.max(...boxes.map((b) => b.y1)),
     };
}

/** Total pixel area of a set of bboxes. */
function totalArea(boxes: BBox[]): number {
     return boxes.reduce((s, b) => s + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
}

/**
 * Union-Find clustering: two boxes are connected when their dilated rects
 * overlap OR when vertical gap < vertGap and horizontal overlap > 10 % of
 * the narrower box's width.
 */
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
               // Dilated overlap
               const ox = Math.min(a.x1 + margin, b.x1 + margin) - Math.max(a.x0 - margin, b.x0 - margin);
               const oy = Math.min(a.y1 + margin, b.y1 + margin) - Math.max(a.y0 - margin, b.y0 - margin);
               if (ox > 0 && oy > 0) { union(i, j); continue; }
               // Vertical proximity + horizontal overlap
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

/**
 * Analyse the OCR result and return the bounding box of the first major figure.
 *
 * Algorithm:
 *  1. Find all "Figure N / Fig. N" captions (excludes single-letter panel labels).
 *     Among these, prefer the one explicitly labelled "Figure 1" / "Fig. 1";
 *     fall back to the first caption in document order if Figure 1 is not found.
 *  2. For the target caption, collect image/chart blocks on the same page (and
 *     the page immediately before it).
 *  3. Apply a capture window: prefer blocks *above* the caption (typical
 *     "caption below" layout); fall back to blocks below or the previous page.
 *     The window is bounded above by the previous caption's bottom edge so that
 *     earlier figures are not swallowed.
 *  4. Cluster remaining candidates by proximity and return the union of the
 *     largest cluster (by total area).
 */
function locateFigureBbox(ocrResult: any): LocatedFigure | null {
     if (!ocrResult?.pages) return null;

     // Build page-dimension lookup from OCR metadata
     const pageDims = new Map<number, { width: number; height: number }>();
     for (const page of ocrResult.pages) {
          const pi: number = page.data?.page_index ?? page.page ?? 0;
          pageDims.set(pi, { width: page.data?.width ?? 1, height: page.data?.height ?? 1 });
     }

     // Step 1 – collect major figure captions
     interface Caption { page: number; bbox: BBox; content: string }
     const captions: Caption[] = [];
     for (const page of ocrResult.pages) {
          const pi: number = page.data?.page_index ?? page.page ?? 0;
          for (const block of page.data?.parsing_res_list ?? []) {
               if (block.block_label !== "figure_title") continue;
               const content: string = (block.block_content ?? "").trim();
               if (!isRealFigureCaption(content)) continue;
               const b: number[] = block.block_bbox;
               if (!b || b.length < 4) continue;
               captions.push({ page: pi, bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] }, content });
          }
     }
     if (captions.length === 0) return null;

     // Prefer the caption explicitly labelled "Figure 1"; fall back to the
     // first caption in document order (pages are iterated sequentially).
     const cap = captions.find((c) => isFigureOne(c.content)) ?? captions[0];
     const dims = pageDims.get(cap.page) ?? { width: 1, height: 1 };

     // Step 2 – collect visual candidate blocks on cap.page and cap.page - 1
     interface VisualBlock { page: number; bbox: BBox }
     const visualBlocks: VisualBlock[] = [];
     for (const page of ocrResult.pages) {
          const pi: number = page.data?.page_index ?? page.page ?? 0;
          if (pi !== cap.page && pi !== cap.page - 1) continue;
          for (const block of page.data?.parsing_res_list ?? []) {
               if (!["image", "chart"].includes(block.block_label)) continue;
               const b: number[] = block.block_bbox;
               if (!b || b.length < 4) continue;
               visualBlocks.push({ page: pi, bbox: { x0: b[0], y0: b[1], x1: b[2], y1: b[3] } });
          }
     }
     if (visualBlocks.length === 0) return null;

     // Step 3 – apply capture window
     const capY0 = cap.bbox.y0;
     const bandH = 0.8 * dims.height;
     // Bottom edge of the nearest preceding caption on the same page
     const prevCapY1 = Math.max(
          0,
          ...captions
               .filter((c) => c.page === cap.page && c.bbox.y1 < capY0)
               .map((c) => c.bbox.y1),
     );

     // Primary: blocks above the caption (caption-below layout)
     let candidates = visualBlocks.filter(
          (v) =>
               v.page === cap.page &&
               v.bbox.y1 <= capY0 &&
               v.bbox.y0 >= capY0 - bandH &&
               v.bbox.y0 >= prevCapY1,
     );
     // Fallback 1: blocks below caption (caption-above layout)
     if (candidates.length === 0)
          candidates = visualBlocks.filter((v) => v.page === cap.page && v.bbox.y0 >= capY0);
     // Fallback 2: previous page
     if (candidates.length === 0)
          candidates = visualBlocks.filter((v) => v.page === cap.page - 1);

     if (candidates.length === 0) return null;

     // Step 4 – cluster by proximity, pick the largest cluster, return its union
     const margin = Math.min(30, 0.015 * dims.height);
     const clusters = clusterBboxes(candidates.map((c) => c.bbox), margin, 40);
     const best = clusters.reduce((a, b) => (totalArea(a) >= totalArea(b) ? a : b));

     return { page: cap.page, bbox: unionBboxes(best), pageWidth: dims.width, pageHeight: dims.height };
}

/**
 * Extract the first figure from a PDF by:
 *  1. Using `locateFigureBbox` to identify the figure region from OCR data.
 *  2. Rendering that region with PyMuPDF (fitz) at 2× zoom for quality.
 * Saves the crop as a .png next to the PDF and returns the filename.
 */
async function extractFirstFigure(
     ocrResult: any,
     pdfPath: string,
     folderRoot: string,
     pdfName: string,
): Promise<string | null> {
     const located = locateFigureBbox(ocrResult);
     if (!located) return null;

     const { page: pageIndex, bbox, pageWidth, pageHeight } = located;
     // Normalise to [0, 1] so the Python script is resolution-independent
     const nx0 = bbox.x0 / pageWidth;
     const ny0 = bbox.y0 / pageHeight;
     const nx1 = bbox.x1 / pageWidth;
     const ny1 = bbox.y1 / pageHeight;

     const figName = pdfName.replace(/\.pdf$/i, "") + "_fig1.png";
     const figDestPath = path.join(folderRoot, figName);
     const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-fig-"));

     // Small Python script: normalised coords → fitz clip → PNG
     const figScript = `
import fitz, sys

pdf_path   = sys.argv[1]
page_index = int(sys.argv[2])
nx0, ny0, nx1, ny1 = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6])
out_path   = sys.argv[7]

doc  = fitz.open(pdf_path)
page = doc[page_index]
pw, ph = page.rect.width, page.rect.height

pad_x = 0.01 * pw
pad_y = 0.01 * ph
clip = fitz.Rect(
    max(0,  nx0 * pw - pad_x),
    max(0,  ny0 * ph - pad_y),
    min(pw, nx1 * pw + pad_x),
    min(ph, ny1 * ph + pad_y),
)
pix = page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=clip)
pix.save(out_path)
print("EXTRACTED")
`.trimStart();

     const scriptPath = path.join(tempDir, "crop_fig.py");
     fs.writeFileSync(scriptPath, figScript);

     try {
          const result = await new Promise<string>((resolve, reject) => {
               const proc = spawn(
                    "python",
                    [scriptPath, pdfPath, String(pageIndex),
                     String(nx0), String(ny0), String(nx1), String(ny1),
                     figDestPath],
                    { cwd: tempDir },
               );
               let stdout = "";
               let stderr = "";
               proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
               proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
               proc.on("close", (code) => {
                    if (code !== 0) reject(new Error(`Figure crop failed (exit ${code}): ${stderr.slice(0, 800)}`));
                    else resolve(stdout.trim());
               });
               proc.on("error", reject);
          });

          if (result.includes("EXTRACTED") && fs.existsSync(figDestPath)) return figName;
          return null;
     } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
     }
}
