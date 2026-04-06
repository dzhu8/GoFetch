import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { libraryFolders, papers, extractedFigures } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import configManager from "@/server";
import { processPaperOCR, queuePaperEmbedding } from "@/lib/embed/paperProcess";
import { extractDocumentMetadata } from "@/lib/citations/parseReferences";

// Long-running OCR jobs can take several minutes for large documents
export const maxDuration = 300;

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY ?? "";

const PYTHON_SCRIPT = `
import os, sys

# On Windows, ensure the system CUDA cuDNN DLLs are discoverable before
# importing paddle.  Without this, paddle may try to load pip-installed
# nvidia-cudnn DLLs that are version-incompatible with paddlepaddle-gpu.
if sys.platform == "win32":
    cuda_bin = os.environ.get("CUDA_PATH", "")
    if cuda_bin:
        cuda_bin = os.path.join(cuda_bin, "bin")
        if os.path.isdir(cuda_bin):
            os.add_dll_directory(cuda_bin)
            os.environ["PATH"] = cuda_bin + os.pathsep + os.environ.get("PATH", "")

from paddleocr import PaddleOCRVL
import sys
import os

pdf_path = sys.argv[1]
pipeline = PaddleOCRVL()

# Try to get page count first
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

/**
 * GET /api/cli/library
 *   → Returns all library folders.
 *
 * GET /api/cli/library?folderName=<name>
 *   → Returns metadata for the named folder and the list of papers it contains.
 *
 * GET /api/cli/library?folderId=<id>
 *   → Same as above but resolved by numeric folder id.
 */
export async function GET(req: NextRequest) {
     const folderName = req.nextUrl.searchParams.get("folderName");
     const folderIdParam = req.nextUrl.searchParams.get("folderId");

     // ── No filter: list all folders ───────────────────────────────────────
     if (!folderName && !folderIdParam) {
          const folders = db
               .select({
                    id: libraryFolders.id,
                    name: libraryFolders.name,
                    rootPath: libraryFolders.rootPath,
                    createdAt: libraryFolders.createdAt,
               })
               .from(libraryFolders)
               .orderBy(libraryFolders.name)
               .all();

          return NextResponse.json({ folders });
     }

     // ── Resolve the target folder ─────────────────────────────────────────
     let folder: { id: number; name: string; rootPath: string; createdAt: string } | undefined;

     if (folderIdParam) {
          const folderId = parseInt(folderIdParam, 10);
          if (isNaN(folderId)) {
               return NextResponse.json({ error: "Invalid folderId" }, { status: 400 });
          }
          folder = db
               .select({
                    id: libraryFolders.id,
                    name: libraryFolders.name,
                    rootPath: libraryFolders.rootPath,
                    createdAt: libraryFolders.createdAt,
               })
               .from(libraryFolders)
               .where(eq(libraryFolders.id, folderId))
               .get();
     } else if (folderName) {
          folder = db
               .select({
                    id: libraryFolders.id,
                    name: libraryFolders.name,
                    rootPath: libraryFolders.rootPath,
                    createdAt: libraryFolders.createdAt,
               })
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();
     }

     if (!folder) {
          return NextResponse.json(
               { error: folderName ? `Folder "${folderName}" not found` : "Folder not found" },
               { status: 404 },
          );
     }

     // ── List papers in the folder ─────────────────────────────────────────
     const paperList = db
          .select({
               id: papers.id,
               fileName: papers.fileName,
               title: papers.title,
               doi: papers.doi,
               status: papers.status,
               createdAt: papers.createdAt,
          })
          .from(papers)
          .where(eq(papers.folderId, folder.id))
          .orderBy(papers.fileName)
          .all();

     return NextResponse.json({
          folder,
          papers: paperList,
     });
}

/**
 * POST /api/cli/library
 *   → Receives a PDF file and a folderId/folderName.
 *   → Saves the PDF, runs OCR (PaddleOCR-VL), and queues embedding.
 */
export async function POST(req: NextRequest) {
     try {
          const formData = await req.formData();
          const pdf = formData.get("pdf") as globalThis.File | null;
          const folderIdParam = formData.get("folderId") as string | null;
          const folderName = formData.get("folderName") as string | null;

          if (!pdf) {
               return NextResponse.json({ error: "No PDF file provided." }, { status: 400 });
          }

          if (!pdf.name.toLowerCase().endsWith(".pdf")) {
               return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
          }

          // ── Resolve the target folder ───────────────────────────────────────
          let folder: { id: number; name: string; rootPath: string } | undefined;

          if (folderIdParam) {
               const folderId = parseInt(folderIdParam, 10);
               if (!isNaN(folderId)) {
                    folder = db
                         .select({ id: libraryFolders.id, name: libraryFolders.name, rootPath: libraryFolders.rootPath })
                         .from(libraryFolders)
                         .where(eq(libraryFolders.id, folderId))
                         .get();
               }
          } else if (folderName) {
               folder = db
                    .select({ id: libraryFolders.id, name: libraryFolders.name, rootPath: libraryFolders.rootPath })
                    .from(libraryFolders)
                    .where(eq(libraryFolders.name, folderName))
                    .get();
          }

          if (!folder) {
               return NextResponse.json({ error: "Target folder not found." }, { status: 404 });
          }

          // ── Save PDF to library folder ──────────────────────────────────────
          const fileName = pdf.name;
          const targetDir = folder.rootPath;
          if (!fs.existsSync(targetDir)) {
               fs.mkdirSync(targetDir, { recursive: true });
          }

          const filePath = path.join(targetDir, fileName);
          // Check if file already exists to avoid overwriting or duplicates in DB
          const existingPaper = db
               .select()
               .from(papers)
               .where(eq(papers.filePath, filePath))
               .get();

          let paperId: number;
          if (existingPaper) {
               paperId = existingPaper.id;
          } else {
               const buffer = Buffer.from(await pdf.arrayBuffer());
               fs.writeFileSync(filePath, buffer);

               const result = db
                    .insert(papers)
                    .values({
                         folderId: folder.id,
                         fileName: fileName,
                         filePath: filePath,
                         status: "uploading",
                    })
                    .run();
               paperId = Number(result.lastInsertRowid);
          }

          // ── Run OCR processing ──────────────────────────────────────────────
          const pythonExe: string = configManager.getConfig("preferences.pythonPath", "python") || "python";
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-ocr-"));
          const scriptPath = path.join(tempDir, "run.py");
          fs.writeFileSync(scriptPath, PYTHON_SCRIPT);

          // Return a stream for progress tracking (similar to related-papers/paddleocr/extract)
          const stream = new ReadableStream({
               async start(controller) {
                    const send = (data: any) => controller.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));

                    try {
                         const env = { ...process.env };
                         const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
                         const cudaPath = process.env.CUDA_PATH;
                         if (cudaPath) {
                              const cudaBin = path.join(cudaPath, "bin");
                              env[pathKey] = `${cudaBin}${path.delimiter}${env[pathKey] ?? ""}`;
                         }

                         const proc = spawn(pythonExe, [scriptPath, filePath], {
                              cwd: tempDir,
                              env,
                         });

                         proc.stdout?.on("data", (data: Buffer) => {
                              const lines = data.toString().split("\n");
                              for (const line of lines) {
                                   if (line.startsWith("PROGRESS:")) {
                                        send({ progress: line.trim() });
                                   }
                              }
                         });

                         proc.on("close", async (code) => {
                              if (code !== 0) {
                                   send({ error: "OCR process failed" });
                                   controller.close();
                                   return;
                              }

                              // Collect page results
                              const files = fs.readdirSync(tempDir);
                              const jsonFiles = files.filter((f) => f.startsWith("page_") && f.endsWith(".json"));
                              jsonFiles.sort((a, b) => {
                                   const na = parseInt(a.replace("page_", "").replace(".json", ""));
                                   const nb = parseInt(b.replace("page_", "").replace(".json", ""));
                                   return na - nb;
                              });

                              const pagesData = jsonFiles.map((f, i) => {
                                   const content = fs.readFileSync(path.join(tempDir, f), "utf-8");
                                   return {
                                        page: i + 1,
                                        data: JSON.parse(content),
                                   };
                              });

                              const ocrResult = {
                                   source: fileName,
                                   pages: pagesData,
                              };

                              const ocrPath = filePath.replace(/\.pdf$/i, "") + ".ocr.json";
                              fs.writeFileSync(ocrPath, JSON.stringify(ocrResult, null, 2));

                              // ── Process OCR and Queue Embedding ─────────────────
                              try {
                                   send({ status: "processing_ocr", message: "Processing OCR and queueing embeddings..." });
                                   await processPaperOCR(paperId, ocrPath);
                                   queuePaperEmbedding(paperId, folder!.name, fileName);

                                   // ── Enrich Metadata ──────────────────────────────
                                   send({ status: "enriching", message: "Extracting metadata and searching Semantic Scholar..." });
                                   const metadata = extractDocumentMetadata(ocrResult);
                                   let title = metadata.title;
                                   let doi = metadata.doi;

                                   let abstract: string | null = null;
                                   let semanticScholarId: string | null = null;
                                   let citation: string | null = null;

                                   // Look for figure
                                   let firstFigurePath: string | null = null;
                                   try {
                                        firstFigurePath = await extractFirstFigure(ocrResult, filePath, fileName, paperId);
                                   } catch (e) {
                                        console.warn("[CLI Library POST] Figure extraction failed:", e);
                                   }

                                   if (doi) {
                                        const s2Paper = await fetchS2PaperByDoi(doi);
                                        if (s2Paper) {
                                             semanticScholarId = s2Paper.paperId ?? null;
                                             abstract = s2Paper.abstract || null;
                                             if (s2Paper.title && !title) title = s2Paper.title;
                                             citation = formatS2Citation(s2Paper);
                                        }
                                   }

                                   if (!semanticScholarId && title) {
                                        const s2Paper = await searchS2ByTitle(title);
                                        if (s2Paper) {
                                             semanticScholarId = s2Paper.paperId ?? null;
                                             abstract = s2Paper.abstract || null;
                                             if (!doi && s2Paper.externalIds?.DOI) doi = s2Paper.externalIds.DOI;
                                             citation = formatS2Citation(s2Paper);
                                        }
                                   }

                                   db.update(papers)
                                        .set({
                                             title: title || fileName.replace(/\.pdf$/i, ""),
                                             doi,
                                             abstract,
                                             semanticScholarId,
                                             citation,
                                             firstFigurePath,
                                             status: "ready",
                                             updatedAt: new Date().toISOString(),
                                        })
                                        .where(eq(papers.id, paperId))
                                        .run();

                                   send({ 
                                        status: "completed", 
                                        paperId, 
                                        metadata: { title, doi, abstract, firstFigurePath } 
                                   });
                              } catch (err) {
                                   console.error("[CLI Library POST] Post-processing error:", err);
                                   send({ error: "Post-OCR processing failed" });
                              } finally {
                                   // Cleanup temp files
                                   try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
                                   controller.close();
                              }
                         });
                    } catch (err) {
                         send({ error: String(err) });
                         controller.close();
                    }
               },
          });

          return new Response(stream, {
               headers: { "Content-Type": "application/x-ndjson" },
          });

     } catch (error) {
          console.error("[Library POST] Error:", error);
          return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
     }
}

// ── S2 Helpers ───────────────────────────────────────────────────────────────

async function fetchS2PaperByDoi(doi: string): Promise<any | null> {
     try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (S2_API_KEY) headers["x-api-key"] = S2_API_KEY;
          const res = await fetch(
               `${S2_BASE}/paper/DOI:${encodeURIComponent(doi)}?fields=paperId,title,abstract,externalIds,year,authors,venue`,
               { headers, signal: AbortSignal.timeout(15_000) },
          );
          if (!res.ok) return null;
          return await res.json();
     } catch {
          return null;
     }
}

async function searchS2ByTitle(title: string): Promise<any | null> {
     try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (S2_API_KEY) headers["x-api-key"] = S2_API_KEY;
          const params = new URLSearchParams({
               query: title,
               limit: "1",
               fields: "paperId,title,abstract,externalIds,year,authors,venue",
          });
          const res = await fetch(`${S2_BASE}/paper/search?${params}`, {
               headers,
               signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) return null;
          const data = await res.json();
          return data?.data?.[0] ?? null;
     } catch {
          return null;
     }
}

function formatS2Citation(paper: any): string {
     const authors = (paper.authors ?? []).map((a: any) => a.name).filter(Boolean);
     const authorStr =
          authors.length > 3 ? `${authors.slice(0, 3).join(", ")} et al.` : authors.join(", ");
     const parts = [authorStr, paper.title];
     if (paper.venue) parts.push(paper.venue);
     if (paper.year) parts.push(String(paper.year));
     const doi = paper.externalIds?.DOI;
     if (doi) parts.push(`https://doi.org/${doi}`);
     return parts.filter(Boolean).join(". ") + ".";
}

// ── Figure Extraction ────────────────────────────────────────────────────────

interface BBox { x0: number; y0: number; x1: number; y1: number }
interface LocatedFigure { page: number; bbox: BBox; pageWidth: number; pageHeight: number }

function isRealFigureCaption(content: string): boolean {
     return /^(Figure|Fig\.)\s*\d+\b/i.test(content.trim());
}

function isFigureOne(content: string): boolean {
     return /^(Figure|Fig\.)\s*1\b/i.test(content.trim());
}

function unionBboxes(boxes: BBox[]): BBox {
     return {
          x0: Math.min(...boxes.map((b) => b.x0)),
          y0: Math.min(...boxes.map((b) => b.y0)),
          x1: Math.max(...boxes.map((b) => b.x1)),
          y1: Math.max(...boxes.map((b) => b.y1)),
     };
}

function totalArea(boxes: BBox[]): number {
     return boxes.reduce((sum, b) => sum + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
}

function clusterBboxes(boxes: BBox[], margin: number, maxDist: number): BBox[][] {
     const n = boxes.length;
     const parent = Array.from({ length: n }, (_, i) => i);
     const find = (i: number): number => {
          if (parent[i] === i) return i;
          return (parent[i] = find(parent[i]));
     };
     const union = (i: number, j: number) => {
          const rootI = find(i);
          const rootJ = find(j);
          if (rootI !== rootJ) parent[rootI] = rootJ;
     };

     for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
               const a = boxes[i];
               const b = boxes[j];
               // Vertical proximity
               const dist = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
               // Horizontal overlap
               const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
               if (dist <= maxDist && overlap > -margin) union(i, j);
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

function locateFigureBbox(ocrResult: any): LocatedFigure | null {
     if (!ocrResult?.pages) return null;
     const pageDims = new Map<number, { width: number; height: number }>();
     for (const page of ocrResult.pages) {
          const pi: number = page.data?.page_index ?? page.page ?? 0;
          pageDims.set(pi, { width: page.data?.width ?? 1, height: page.data?.height ?? 1 });
     }

     const captions: { page: number; bbox: BBox; content: string }[] = [];
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

     const cap = captions.find((c) => isFigureOne(c.content)) ?? captions[0];
     const dims = pageDims.get(cap.page) ?? { width: 1, height: 1 };

     const visualBlocks: { page: number; bbox: BBox }[] = [];
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

     const capY0 = cap.bbox.y0;
     const bandH = 0.8 * dims.height;
     const prevCapY1 = Math.max(
          0,
          ...captions.filter((c) => c.page === cap.page && c.bbox.y1 < capY0).map((c) => c.bbox.y1)
     );

     let candidates = visualBlocks.filter(
          (v) =>
               v.page === cap.page &&
               v.bbox.y1 <= capY0 &&
               v.bbox.y0 >= capY0 - bandH &&
               v.bbox.y0 >= prevCapY1
     );
     if (candidates.length === 0)
          candidates = visualBlocks.filter((v) => v.page === cap.page && v.bbox.y0 >= capY0);
     if (candidates.length === 0)
          candidates = visualBlocks.filter((v) => v.page === cap.page - 1);

     if (candidates.length === 0) return null;

     const margin = Math.min(30, 0.015 * dims.height);
     const clusters = clusterBboxes(
          candidates.map((c) => c.bbox),
          margin,
          40
     );
     const best = clusters.reduce((a, b) => (totalArea(a) >= totalArea(b) ? a : b));

     return { page: cap.page, bbox: unionBboxes(best), pageWidth: dims.width, pageHeight: dims.height };
}

async function extractFirstFigure(
     ocrResult: any,
     pdfPath: string,
     pdfName: string,
     paperId: number,
): Promise<string | null> {
     const located = locateFigureBbox(ocrResult);
     if (!located) return null;

     const { page: pageIndex, bbox, pageWidth, pageHeight } = located;
     const nx0 = bbox.x0 / pageWidth;
     const ny0 = bbox.y0 / pageHeight;
     const nx1 = bbox.x1 / pageWidth;
     const ny1 = bbox.y1 / pageHeight;

     const figName = pdfName.replace(/\.pdf$/i, "") + "_fig1.png";
     const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-fig-"));
     const tmpFigPath = path.join(tempDir, figName);

     const figScript = `
import fitz, sys
doc = fitz.open(sys.argv[1]); page = doc[int(sys.argv[2])]; pw, ph = page.rect.width, page.rect.height
nx0, ny0, nx1, ny1 = map(float, sys.argv[3:7])
clip = fitz.Rect(max(0, nx0*pw-0.01*pw), max(0, ny0*ph-0.01*ph), min(pw, nx1*pw+0.01*pw), min(ph, ny1*ph+0.01*ph))
page.get_pixmap(matrix=fitz.Matrix(2.0, 2.0), clip=clip).save(sys.argv[7]); print("EXTRACTED")
`.trim();

     const scriptPath = path.join(tempDir, "crop_fig.py");
     fs.writeFileSync(scriptPath, figScript);

     try {
          const pythonExe: string = configManager.getConfig("preferences.pythonPath", "python") || "python";
          const result = await new Promise<string>((resolve, reject) => {
               const proc = spawn(
                    pythonExe,
                    [
                         scriptPath,
                         pdfPath,
                         String(pageIndex),
                         String(nx0),
                         String(ny0),
                         String(nx1),
                         String(ny1),
                         tmpFigPath,
                    ],
                    { cwd: tempDir, env: process.env }
               );
               let stdout = "";
               proc.stdout?.on("data", (d) => (stdout += d.toString()));
               proc.on("close", (code) =>
                    code === 0 ? resolve(stdout) : reject(new Error(`Exit ${code}`))
               );
          });
          if (result.includes("EXTRACTED") && fs.existsSync(tmpFigPath)) {
               const imageData = fs.readFileSync(tmpFigPath);
               db.insert(extractedFigures)
                    .values({
                         paperId,
                         filename: figName,
                         pageIndex,
                         docOrder: 0,
                         caption: "",
                         imageData,
                    })
                    .onConflictDoNothing()
                    .run();
               return figName;
          }
          return null;
     } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
     }
}
