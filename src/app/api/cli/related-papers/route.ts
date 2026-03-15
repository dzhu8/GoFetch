import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import configManager from "@/server";
import { buildRelatedPapersGraph, GraphConstructionMethod } from "@/lib/relatedPapers/graph";
import { parseReferences, extractDocumentMetadata } from "@/lib/citations/parseReferences";

// Allow enough time for OCR on large documents
export const maxDuration = 1200;

const PYTHON_SCRIPT = `
import os, sys

if sys.platform == "win32":
    cuda_bin = os.path.join(os.environ.get("CUDA_PATH", ""), "bin")
    if os.path.isdir(cuda_bin):
        os.add_dll_directory(cuda_bin)
        os.environ["PATH"] = cuda_bin + os.pathsep + os.environ.get("PATH", "")

from paddleocr import PaddleOCRVL

pdf_path = sys.argv[1]
pipeline = PaddleOCRVL()

for i, res in enumerate(pipeline.predict(pdf_path)):
    res.save_to_json(f"page_{i}.json")
    print(f"PROGRESS:PAGE:{i+1}", flush=True)
`.trimStart();

/**
 * Run PaddleOCR-VL on a local PDF path and return the assembled OCR result
 * object `{ source, pages }`.  Writes page JSONs to a temp directory, then
 * cleans up after assembly.
 */
async function runOcr(pdfPath: string): Promise<any> {
     const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-ocr-"));
     const scriptPath = path.join(tempDir, "run.py");
     fs.writeFileSync(scriptPath, PYTHON_SCRIPT);

     try {
          const env = { ...process.env };
          const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
          const cudaPath = process.env.CUDA_PATH;
          if (cudaPath) {
               const cudaBin = path.join(cudaPath, "bin");
               env[pathKey] = `${cudaBin}${path.delimiter}${env[pathKey] ?? ""}`;
          }

          const pythonExe: string =
               configManager.getConfig("preferences.pythonPath", "python") || "python";

          await new Promise<void>((resolve, reject) => {
               const proc = spawn(pythonExe, [scriptPath, pdfPath], { cwd: tempDir, env });

               let stderrAccum = "";
               proc.stderr?.on("data", (d: Buffer) => {
                    stderrAccum += d.toString();
               });
               proc.on("close", (code) => {
                    if (code !== 0) {
                         reject(
                              new Error(
                                   `PaddleOCR exited with code ${code}: ${stderrAccum.slice(0, 500)}`,
                              ),
                         );
                    } else {
                         resolve();
                    }
               });
               proc.on("error", (err) => reject(err));
          });

          const pageFiles = fs
               .readdirSync(tempDir)
               .filter((f) => /^page_\d+\.json$/.test(f))
               .sort((a, b) => {
                    const ai = parseInt(a.match(/\d+/)![0], 10);
                    const bi = parseInt(b.match(/\d+/)![0], 10);
                    return ai - bi;
               });

          if (pageFiles.length === 0) {
               throw new Error("OCR produced no output. Ensure PaddleOCR-VL is installed.");
          }

          const pages = pageFiles.map((f, i) => {
               const raw = fs.readFileSync(path.join(tempDir, f), "utf-8");
               try {
                    return { page: i, data: JSON.parse(raw) };
               } catch {
                    return { page: i, data: raw };
               }
          });

          return { source: path.basename(pdfPath), pages };
     } finally {
          try {
               fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
               // best-effort cleanup
          }
     }
}

/**
 * POST /api/cli/related-papers
 *
 * Body: { pdfPath: string, method?: GraphConstructionMethod }
 *
 * Accepts an absolute path to a local PDF file.  If a `.ocr.json` sidecar
 * already exists alongside the PDF it is reused; otherwise PaddleOCR-VL is
 * invoked and the result is saved as `<name>.ocr.json` next to the PDF.
 *
 * Returns the same RelatedPapersResponse shape as /api/related-papers.
 */
export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const { pdfPath, method } = body as { pdfPath?: string; method?: GraphConstructionMethod };

          if (!pdfPath || typeof pdfPath !== "string") {
               return NextResponse.json({ error: "pdfPath is required." }, { status: 400 });
          }

          if (!pdfPath.toLowerCase().endsWith(".pdf")) {
               return NextResponse.json(
                    { error: "Only PDF files are accepted. Please provide a path ending in .pdf." },
                    { status: 400 },
               );
          }

          if (!fs.existsSync(pdfPath)) {
               return NextResponse.json(
                    { error: `File not found: ${pdfPath}` },
                    { status: 404 },
               );
          }

          // Reuse existing OCR sidecar if available
          const ocrPath = pdfPath.replace(/\.pdf$/i, ".ocr.json");
          let ocrResult: any;

          if (fs.existsSync(ocrPath)) {
               ocrResult = JSON.parse(fs.readFileSync(ocrPath, "utf-8"));
          } else {
               ocrResult = await runOcr(pdfPath);
               // Save sidecar for future reuse
               fs.writeFileSync(ocrPath, JSON.stringify(ocrResult), "utf-8");
          }

          const { title, doi } = extractDocumentMetadata(ocrResult);
          const pdfTitle = title ?? path.basename(pdfPath, ".pdf");
          const pdfDoi = doi ?? undefined;

          const refs = parseReferences(ocrResult);
          const terms = refs.map((r) => r.searchTerm);
          const isDoiFlags = refs.map((r) => r.isDoi);

          if (!terms.length) {
               return NextResponse.json(
                    { error: "No references found in the PDF. Cannot build related-papers graph." },
                    { status: 422 },
               );
          }

          const activeMethod =
               method ??
               configManager.getConfig(
                    "personalization.graphConstructionMethod",
                    GraphConstructionMethod.Snowball,
               );

          const response = await buildRelatedPapersGraph(
               activeMethod,
               terms,
               isDoiFlags,
               pdfTitle,
               pdfDoi,
          );

          return NextResponse.json(response);
     } catch (err) {
          console.error("[CLI Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Failed to build related-papers graph";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
