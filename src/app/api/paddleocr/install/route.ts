import { NextResponse } from "next/server";
import { spawn } from "child_process";

function parseCudaVersion(output: string): string | null {
     const match = output.match(/release\s+(\d+)\.(\d+)/i);
     if (!match) return null;
     return `cu${match[1]}${match[2]}`;
}

async function detectNvcc(): Promise<{ cudaTag: string } | { error: string }> {
     return new Promise((resolve) => {
          const proc = spawn("nvcc", ["--version"]);
          let stdout = "";
          let stderr = "";

          proc.stdout?.on("data", (d: Buffer) => {
               stdout += d.toString();
          });
          proc.stderr?.on("data", (d: Buffer) => {
               stderr += d.toString();
          });

          const timeout = setTimeout(() => {
               proc.kill();
               resolve({ error: "CUDA detection timed out after 15 seconds." });
          }, 15000);

          proc.on("close", (code) => {
               clearTimeout(timeout);
               const combined = stdout + stderr;
               if (code !== 0 && !combined.includes("release")) {
                    const msg = "nvcc not found. A CUDA Toolkit installation is required. Please install the CUDA Toolkit from developer.nvidia.com/cuda-downloads and ensure nvcc is on your PATH.";
                    console.error("[PaddleOCR] CUDA detection failed (exit code", code, "):", combined.trim() || msg);
                    resolve({ error: msg });
                    return;
               }
               const cudaTag = parseCudaVersion(combined);
               if (!cudaTag) {
                    const msg = `Could not determine CUDA version from nvcc output: ${combined.slice(0, 300)}`;
                    console.error("[PaddleOCR]", msg);
                    resolve({ error: msg });
                    return;
               }
               resolve({ cudaTag });
          });

          proc.on("error", (err) => {
               clearTimeout(timeout);
               const msg = "nvcc not found. A CUDA Toolkit installation is required. Please install the CUDA Toolkit from developer.nvidia.com/cuda-downloads and ensure nvcc is on your PATH.";
               console.error("[PaddleOCR] nvcc spawn error:", err.message);
               resolve({ error: msg });
          });
     });
}

// PaddlePaddle publishes wheels for these CUDA versions only (ordered ascending).
// If the detected version is newer than the latest supported, fall back to the closest one.
const PADDLE_SUPPORTED_CUDA = ["cu118", "cu120", "cu123", "cu126"];

function clampCudaTag(detected: string): string {
     if (PADDLE_SUPPORTED_CUDA.includes(detected)) return detected;
     // Sort supported tags and pick the highest one that is <= detected
     const detectedNum = parseInt(detected.replace("cu", ""), 10);
     const sorted = [...PADDLE_SUPPORTED_CUDA].sort((a, b) =>
          parseInt(a.replace("cu", ""), 10) - parseInt(b.replace("cu", ""), 10)
     );
     let best = sorted[0];
     for (const tag of sorted) {
          if (parseInt(tag.replace("cu", ""), 10) <= detectedNum) best = tag;
     }
     return best;
}

export async function POST() {
     // Phase 1: detect CUDA synchronously before starting the stream
     const cudaResult = await detectNvcc();
     if ("error" in cudaResult) {
          return NextResponse.json({ error: cudaResult.error }, { status: 400 });
     }

     const detectedTag = cudaResult.cudaTag;
     const cudaTag = clampCudaTag(detectedTag);
     if (cudaTag !== detectedTag) {
          console.log(`[PaddleOCR] CUDA ${detectedTag} not directly supported; using nearest available build: ${cudaTag}`);
     }
     const paddleURL = `https://www.paddlepaddle.org.cn/packages/stable/${cudaTag}/`;

     const commands: Array<[string, string[]]> = [
          ["pip", ["install", "paddlepaddle-gpu==3.2.1", "--extra-index-url", paddleURL]],
          ["pip", ["install", "paddleocr[doc-parser]"]],
     ];

     const encoder = new TextEncoder();

     const stream = new ReadableStream<Uint8Array>({
          start(controller) {
               const send = (obj: object) => {
                    try {
                         controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
                    } catch {
                         // Controller may be closed already; ignore
                    }
               };

               send({
                    type: "cuda",
                    version: cudaTag,
                    detectedVersion: detectedTag,
               });

               let cmdIndex = 0;

               const runNext = () => {
                    if (cmdIndex >= commands.length) {
                         send({ type: "done" });
                         controller.close();
                         return;
                    }

                    const [cmd, args] = commands[cmdIndex++];
                    send({ type: "command", line: `${cmd} ${args.join(" ")}` });

                    const proc = spawn(cmd, args, { env: process.env });

                    const handleData = (data: Buffer) => {
                         // pip uses \r to overwrite progress lines in-place; split on both \r and \n
                         for (const line of data.toString().split(/\r?\n|\r/)) {
                              const trimmed = line.trim();
                              if (!trimmed) continue;
                              // Only forward lines with actual download stats or status messages.
                              // Skip raw progress bar characters (━, dots-only, ANSI escape sequences)
                              // that pip emits for terminal rendering.
                              const hasStats =
                                   /\d+[\.,]\d+\s*[KMGkmg]?B/.test(trimmed) || // size values: 10.5 MB, 1.2 GB
                                   /eta\s+[\d:]+/i.test(trimmed) ||             // eta 0:00:58
                                   /MB\/s|KB\/s|GB\/s/i.test(trimmed) ||        // transfer rate
                                   /successfully installed/i.test(trimmed) ||   // completion
                                   /downloading\s+https?:\/\//i.test(trimmed) || // "Downloading https://..."
                                   /installing\s+collected/i.test(trimmed) ||   // "Installing collected packages"
                                   /requirement already satisfied/i.test(trimmed); // already installed
                              if (hasStats) {
                                   // Strip ANSI escape codes before sending
                                   const clean = trimmed.replace(/\x1b\[[0-9;]*[mGKHF]/g, "").trim();
                                   if (clean) send({ type: "output", line: clean });
                              }
                         }
                    };

                    proc.stdout?.on("data", handleData);
                    proc.stderr?.on("data", handleData);

                    proc.on("close", (code) => {
                         if (code !== 0) {
                              const msg = `Command failed with exit code ${code}`;
                              console.error(`[PaddleOCR] ${cmd} ${args.join(" ")} —`, msg);
                              send({ type: "error", message: msg });
                              controller.close();
                              return;
                         }
                         runNext();
                    });

                    proc.on("error", (err) => {
                         console.error(`[PaddleOCR] Failed to spawn ${cmd}:`, err.message);
                         send({ type: "error", message: err.message });
                         controller.close();
                    });
               };

               runNext();
          },
     });

     return new NextResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
     });
}
