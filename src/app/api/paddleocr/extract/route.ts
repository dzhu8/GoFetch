import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Long-running OCR jobs can take several minutes for large documents
export const maxDuration = 300;

const PYTHON_SCRIPT = `
import os, sys

# On Windows, ensure the system CUDA cuDNN DLLs are discoverable before
# importing paddle.  Without this, paddle may try to load pip-installed
# nvidia-cudnn DLLs that are version-incompatible with paddlepaddle-gpu.
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

export async function POST(req: NextRequest) {
     let tempDir: string | null = null;

     const encoder = new TextEncoder();

     try {
          const formData = await req.formData();
          const pdf = formData.get("pdf") as globalThis.File | null;

          if (!pdf) {
               return NextResponse.json({ error: "No PDF file provided." }, { status: 400 });
          }

          if (!pdf.name.toLowerCase().endsWith(".pdf")) {
               return NextResponse.json({ error: "Only PDF files are accepted." }, { status: 400 });
          }

          // Create isolated temp directory for this extraction job
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gofetch-ocr-"));

          const pdfPath = path.join(tempDir, "input.pdf");
          const scriptPath = path.join(tempDir, "run.py");

          fs.writeFileSync(pdfPath, Buffer.from(await pdf.arrayBuffer()));
          fs.writeFileSync(scriptPath, PYTHON_SCRIPT);

          // We return a ReadableStream to provide progress updates
          const stream = new ReadableStream({
               async start(controller) {
                    try {
                         // Run PaddleOCR-VL — output page_N.json files land in tempDir (cwd)
                         // Ensure system CUDA bin is on PATH so the Python
                         // process can find cuDNN DLLs from the CUDA Toolkit.
                         // On Windows the actual env key is "Path" (not "PATH"),
                         // but process.env has a case-insensitive getter that
                         // hides this.  Find the real key so we don't create a
                         // duplicate that shadows the original.
                         const env = { ...process.env };
                         const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
                         const cudaPath = process.env.CUDA_PATH;
                         if (cudaPath) {
                              const cudaBin = path.join(cudaPath, "bin");
                              env[pathKey] = `${cudaBin}${path.delimiter}${env[pathKey] ?? ""}`;
                         }

                         await new Promise<void>((resolve, reject) => {
                              const proc = spawn("python", [scriptPath, pdfPath], {
                                   cwd: tempDir!,
                                   env,
                              });

                              let stderr = "";

                              proc.stdout?.on("data", (d: Buffer) => {
                                   const lines = d.toString().split("\n");
                                   for (const line of lines) {
                                        const trimmed = line.trim();
                                        if (trimmed.startsWith("PROGRESS:")) {
                                             const parts = trimmed.split(":");
                                             if (parts[1] === "TOTAL") {
                                                  controller.enqueue(
                                                       encoder.encode(
                                                            JSON.stringify({ type: "total", value: parseInt(parts[2]) }) + "\n"
                                                       )
                                                  );
                                             } else if (parts[1] === "PAGE") {
                                                  controller.enqueue(
                                                       encoder.encode(
                                                            JSON.stringify({ type: "page", value: parseInt(parts[2]) }) + "\n"
                                                       )
                                                  );
                                             }
                                        } else if (trimmed) {
                                             console.log("[PaddleOCR extract]", trimmed);
                                        }
                                   }
                              });

                              proc.stderr?.on("data", (d: Buffer) => {
                                   stderr += d.toString();
                                   console.error("[PaddleOCR extract]", d.toString().trim());
                              });

                              proc.on("close", (code) => {
                                   if (code !== 0) {
                                        reject(new Error(`PaddleOCR exited with code ${code}: ${stderr.slice(0, 500)}`));
                                   } else {
                                        resolve();
                                   }
                              });

                              proc.on("error", (err) => {
                                   console.error("[PaddleOCR extract] spawn error:", err.message);
                                   reject(err);
                              });
                         });

                         // Collect and combine all page JSONs in page order
                         const pageFiles = fs
                              .readdirSync(tempDir!)
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
                              const raw = fs.readFileSync(path.join(tempDir!, f), "utf-8");
                              try {
                                   return { page: i, data: JSON.parse(raw) };
                              } catch {
                                   return { page: i, data: raw };
                              }
                         });

                         const result = { source: pdf.name, pages };
                         controller.enqueue(encoder.encode(JSON.stringify({ type: "complete", data: result }) + "\n"));
                         controller.close();
                    } catch (err) {
                         const msg = err instanceof Error ? err.message : "OCR extraction failed";
                         controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: msg }) + "\n"));
                         controller.close();
                    } finally {
                         if (tempDir) {
                              try {
                                   fs.rmSync(tempDir, { recursive: true, force: true });
                              } catch (cleanupErr) {
                                   console.warn("[PaddleOCR extract] Temp cleanup failed:", cleanupErr);
                              }
                         }
                    }
               },
          });

          return new NextResponse(stream, {
               headers: {
                    "Content-Type": "application/x-ndjson",
               },
          });
     } catch (err) {
          console.error("[PaddleOCR extract] initial error:", err);
          const msg = err instanceof Error ? err.message : "OCR extraction failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
