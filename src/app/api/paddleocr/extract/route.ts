import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Long-running OCR jobs can take several minutes for large documents
export const maxDuration = 300;

const PYTHON_SCRIPT = `
from paddleocr import PaddleOCRVL
import sys

pipeline = PaddleOCRVL()
for i, res in enumerate(pipeline.predict(sys.argv[1])):
    res.save_to_json(f"page_{i}.json")
`.trimStart();

export async function POST(req: NextRequest) {
     let tempDir: string | null = null;

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

          // Run PaddleOCR-VL — output page_N.json files land in tempDir (cwd)
          await new Promise<void>((resolve, reject) => {
               const proc = spawn("python", [scriptPath, pdfPath], {
                    cwd: tempDir!,
                    env: process.env,
               });

               let stderr = "";

               proc.stdout?.on("data", (d: Buffer) => {
                    console.log("[PaddleOCR extract]", d.toString().trim());
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
               .readdirSync(tempDir)
               .filter((f) => /^page_\d+\.json$/.test(f))
               .sort((a, b) => {
                    const ai = parseInt(a.match(/\d+/)![0], 10);
                    const bi = parseInt(b.match(/\d+/)![0], 10);
                    return ai - bi;
               });

          if (pageFiles.length === 0) {
               return NextResponse.json(
                    {
                         error: "OCR produced no output. Ensure PaddleOCR-VL is installed and the PDF is readable.",
                    },
                    { status: 500 }
               );
          }

          const pages = pageFiles.map((f, i) => {
               const raw = fs.readFileSync(path.join(tempDir!, f), "utf-8");
               try {
                    return { page: i, data: JSON.parse(raw) };
               } catch {
                    return { page: i, data: raw };
               }
          });

          const outputJson = JSON.stringify({ source: pdf.name, pages }, null, 2);
          const outputFileName = pdf.name.replace(/\.pdf$/i, "-ocr.json");

          return new NextResponse(outputJson, {
               headers: {
                    "Content-Type": "application/json",
                    "Content-Disposition": `attachment; filename="${encodeURIComponent(outputFileName)}"`,
               },
          });
     } catch (err) {
          console.error("[PaddleOCR extract] error:", err);
          const msg = err instanceof Error ? err.message : "OCR extraction failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     } finally {
          if (tempDir) {
               try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
               } catch (cleanupErr) {
                    console.warn("[PaddleOCR extract] Temp cleanup failed:", cleanupErr);
               }
          }
     }
}
