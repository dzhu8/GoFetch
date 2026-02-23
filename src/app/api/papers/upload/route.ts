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

/**
 * Try to extract the first figure from the PDF using PyMuPDF (fitz).
 * Saves as a .png next to the PDF and returns the filename.
 */
async function extractFirstFigure(
     ocrResult: any,
     pdfPath: string,
     folderRoot: string,
     pdfName: string,
): Promise<string | null> {
     // Use a small Python script to extract the first image from the PDF
     const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-fig-"));
     const figName = pdfName.replace(/\.pdf$/i, "") + "_fig1.png";
     const figDestPath = path.join(folderRoot, figName);

     const figScript = `
import fitz
import sys

pdf_path = sys.argv[1]
out_path = sys.argv[2]

doc = fitz.open(pdf_path)
for page_num in range(min(len(doc), 10)):
    page = doc[page_num]
    images = page.get_images(full=True)
    for img_index, img in enumerate(images):
        xref = img[0]
        base_image = doc.extract_image(xref)
        if base_image and base_image.get("image"):
            img_bytes = base_image["image"]
            if len(img_bytes) > 5000:
                with open(out_path, "wb") as f:
                    f.write(img_bytes)
                print("EXTRACTED")
                sys.exit(0)
doc.close()
print("NONE")
`;

     const scriptPath = path.join(tempDir, "extract_fig.py");
     fs.writeFileSync(scriptPath, figScript);

     try {
          const result = await new Promise<string>((resolve, reject) => {
               const proc = spawn("python", [scriptPath, pdfPath, figDestPath], { cwd: tempDir });
               let stdout = "";
               proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
               proc.on("close", (code) => {
                    if (code !== 0) reject(new Error("Figure extraction failed"));
                    else resolve(stdout.trim());
               });
               proc.on("error", reject);
          });

          if (result.includes("EXTRACTED") && fs.existsSync(figDestPath)) {
               return figName;
          }
          return null;
     } finally {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
     }
}
