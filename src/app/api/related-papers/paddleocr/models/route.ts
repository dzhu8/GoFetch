import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import configManager from "@/server";

const execFileAsync = promisify(execFile);

const PADDLEOCR_CURATED_MODELS = [
     {
          name: "PaddleOCR-VL",
          description: "High-performance document OCR — installed via pip (NVIDIA GPU + CUDA required)",
     },
];

async function isPaddleOCRInstalled(): Promise<boolean> {
     try {
          // Use `pip show` rather than `import paddleocr` to avoid GPU/CUDA
          // library initialisation, which can fail or time out even when the
          // package is correctly installed (e.g. torch CUDA libs conflict).
          const pythonExe: string = configManager.getConfig("preferences.pythonPath", "python") || "python";
          await execFileAsync(pythonExe, ["-m", "pip", "show", "paddleocr"], { timeout: 10000 });
          return true;
     } catch {
          return false;
     }
}

export async function GET() {
     try {
          const installed = await isPaddleOCRInstalled();

          const models = PADDLEOCR_CURATED_MODELS.map((m) => ({
               ...m,
               installed,
               supportsOCR: true,
               supportsChat: false,
               supportsEmbedding: false,
          }));

          return NextResponse.json({ models });
     } catch (error) {
          return NextResponse.json(
               { error: error instanceof Error ? error.message : "Failed to check PaddleOCR status" },
               { status: 500 }
          );
     }
}
