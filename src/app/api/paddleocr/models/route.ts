import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const PADDLEOCR_CURATED_MODELS = [
     {
          name: "PaddleOCR-VL",
          description: "High-performance document OCR — installed via pip (NVIDIA GPU + CUDA required)",
     },
];

async function isPaddleOCRInstalled(): Promise<boolean> {
     try {
          await execAsync('python -c "import paddleocr"', { timeout: 10000 });
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
