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

// Returns true if `import torch` succeeds in the current Python environment.
function checkTorchInstalled(): Promise<boolean> {
     return new Promise((resolve) => {
          const proc = spawn("python", ["-c", "import torch"]);
          const timeout = setTimeout(() => { proc.kill(); resolve(false); }, 10000);
          proc.on("close", (code) => { clearTimeout(timeout); resolve(code === 0); });
          proc.on("error", () => { clearTimeout(timeout); resolve(false); });
     });
}

// Detect cuDNN version via torch.backends.cudnn.version().
// Returns "major.minor" (e.g. "9.5") or null if unavailable.
// Encoding: cuDNN < 9 uses MAJOR*1000 + MINOR*100 (e.g. 8902); cuDNN >= 9 uses MAJOR*10000 + MINOR*100 (e.g. 90500).
function detectCudnnViaTorch(): Promise<string | null> {
     return new Promise((resolve) => {
          const proc = spawn("python", [
               "-c",
               "import torch; print('cuDNN:', torch.backends.cudnn.version())",
          ]);
          let output = "";
          proc.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
          const timeout = setTimeout(() => { proc.kill(); resolve(null); }, 15000);
          proc.on("close", () => {
               clearTimeout(timeout);
               const match = output.match(/cuDNN:\s*(\d+)/i);
               if (!match) { resolve(null); return; }
               const v = parseInt(match[1], 10);
               const major = v >= 10000 ? Math.floor(v / 10000) : Math.floor(v / 1000);
               const minor = v >= 10000 ? Math.floor((v % 10000) / 100) : Math.floor((v % 1000) / 100);
               resolve(`${major}.${minor}`);
          });
          proc.on("error", () => { clearTimeout(timeout); resolve(null); });
     });
}

// PaddlePaddle publishes wheels for these CUDA versions only (ordered ascending).
// If the detected version is newer than the latest supported, fall back to the closest one.
const PADDLE_SUPPORTED_CUDA = ["cu118", "cu120", "cu123", "cu126"];

// Wheel index URL for each CUDA tag.
// cu126: stable only has 3.0.0 which lacks `fused_rms_norm_ext` needed by
// paddleocr 3.4+.  The nightly index carries daily 3.4.0.dev builds that match.
const PADDLE_INDEX_URL_FOR_TAG: Record<string, string> = {
     cu126: "https://www.paddlepaddle.org.cn/packages/nightly/cu126/",
     cu123: "https://www.paddlepaddle.org.cn/packages/stable/cu123/",
     cu120: "https://www.paddlepaddle.org.cn/packages/stable/cu120/",
     cu118: "https://www.paddlepaddle.org.cn/packages/stable/cu118/",
};

// Exact wheel version to pin.  null = no pin, install latest (used for nightly).
const PADDLE_VERSION_FOR_TAG: Record<string, string | null> = {
     cu126: null,                      // nightly latest – no pin
     cu123: "3.0.0.dev20241230",       // only dev build available for cu123
     cu120: "2.6.1.post120",
     cu118: "2.6.1.post118",
};

// Tags whose index only carries pre-release (dev/rc) builds → need --pre flag.
const PADDLE_PRE_TAGS = new Set(["cu126", "cu123"]);

// Minimum CUDNN version (encoded as major * 10 + minor) required for each CUDA tag.
// Determined from Paddle runtime warnings and release notes.
const PADDLE_MIN_CUDNN: Record<string, number> = {
     cu126: 90, // CUDNN 9.x
     cu123: 93, // CUDNN 9.3
     cu120: 89, // CUDNN 8.9
     cu118: 87, // CUDNN 8.7
};

function parseCudnnNum(version: string | null): number | null {
     if (!version) return null;
     const [maj, min] = version.split(".").map(Number);
     if (isNaN(maj)) return null;
     return maj * 10 + (min || 0);
}

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

// Given a preferred CUDA tag (already CUDA-clamped) and the system CUDNN version,
// walk down to the highest tag whose minimum CUDNN requirement is satisfied.
// If CUDNN cannot be detected, trust the preferred tag — cu126/3.0.0 requires only
// CUDNN 9.x which any CUDA 12.6+ system will have.
function selectCompatibleCudaTag(preferredTag: string, cudnnVersion: string | null): string {
     const sorted = [...PADDLE_SUPPORTED_CUDA].sort(
          (a, b) => parseInt(b.replace("cu", ""), 10) - parseInt(a.replace("cu", ""), 10)
     );

     const cudnnNum = parseCudnnNum(cudnnVersion);
     if (cudnnNum === null) {
          console.warn(`[PaddleOCR] CUDNN version undetectable; using CUDA-clamped tag ${preferredTag}`);
          return preferredTag;
     }

     // Start from the preferred tag and walk down until CUDNN requirement is met
     const startIdx = sorted.indexOf(preferredTag);
     const candidates = startIdx >= 0 ? sorted.slice(startIdx) : sorted;
     for (const tag of candidates) {
          if ((PADDLE_MIN_CUDNN[tag] ?? 0) <= cudnnNum) return tag;
     }
     return sorted[sorted.length - 1]; // Absolute fallback
}

export async function POST() {
     // Detect CUDA synchronously before starting the stream.
     // cuDNN detection happens inside the stream after torch is confirmed available.
     const cudaResult = await detectNvcc();
     if ("error" in cudaResult) {
          return NextResponse.json({ error: cudaResult.error }, { status: 400 });
     }

     const detectedTag = cudaResult.cudaTag;
     const cudaClamped = clampCudaTag(detectedTag);

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

               const handleData = (data: Buffer) => {
                    // pip uses \r to overwrite progress lines in-place; split on both \r and \n
                    for (const raw of data.toString().split(/\r?\n|\r/)) {
                         // Strip ANSI escape codes and box-drawing / spacer characters first
                         const line = raw
                              .replace(/\x1b\[[0-9;]*[mGKHF]/g, "")
                              .replace(/[━─=\-\.·•]+/g, " ")
                              .trim();
                         if (!line) continue;

                         // Progress line: extract "N.N / N.N MB • speed • ETA H:MM:SS"
                         const progressMatch = line.match(
                              /(\d+\.?\d*)\s*\/\s*(\d+\.?\d*)\s*(MB|GB|KB)\b/i
                         );
                         if (progressMatch) {
                              const [, dl, total, unit] = progressMatch;
                              const parts: string[] = [`${dl} / ${total} ${unit.toUpperCase()}`];
                              const speedMatch = line.match(/(\d+\.?\d*\s*(?:MB|KB|GB)\/s)/i);
                              if (speedMatch) parts.push(speedMatch[1].trim());
                              const etaMatch = line.match(/\beta\s+([\d:]+)/i);
                              if (etaMatch) parts.push(`ETA ${etaMatch[1]}`);
                              send({ type: "output", line: parts.join(" • ") });
                              continue;
                         }

                         // Downloading: show only the wheel filename, not the full URL
                         const dlMatch = line.match(/Downloading\s+(https?:\/\/\S+)/i);
                         if (dlMatch) {
                              const filename = dlMatch[1].split("/").pop()?.split("?")[0] ?? dlMatch[1];
                              send({ type: "output", line: `Downloading ${filename}` });
                              continue;
                         }

                         // Pass through clean status messages verbatim
                         if (
                              /successfully installed/i.test(line) ||
                              /installing\s+collected/i.test(line) ||
                              /requirement already satisfied/i.test(line)
                         ) {
                              send({ type: "output", line });
                         }
                    }
               };

               const runCommand = (cmd: string, args: string[]): Promise<boolean> => {
                    return new Promise((resolve) => {
                         send({ type: "command", line: `${cmd} ${args.join(" ")}` });
                         const proc = spawn(cmd, args, { env: process.env });
                         proc.stdout?.on("data", handleData);
                         proc.stderr?.on("data", handleData);
                         proc.on("close", (code) => {
                              if (code !== 0) {
                                   const msg = `Command failed with exit code ${code}`;
                                   console.error(`[PaddleOCR] ${cmd} ${args.join(" ")} —`, msg);
                                   send({ type: "error", message: msg });
                                   resolve(false);
                                   return;
                              }
                              resolve(true);
                         });
                         proc.on("error", (err) => {
                              console.error(`[PaddleOCR] Failed to spawn ${cmd}:`, err.message);
                              send({ type: "error", message: err.message });
                              resolve(false);
                         });
                    });
               };

               const runPipeline = async () => {
                    // Step 1: Ensure torch is installed (required for cuDNN detection)
                    const torchInstalled = await checkTorchInstalled();
                    if (!torchInstalled) {
                         const torchIndexUrl = `https://download.pytorch.org/whl/${cudaClamped}`;
                         const ok = await runCommand("pip3", [
                              "install", "torch", "torchvision",
                              "--index-url", torchIndexUrl,
                         ]);
                         if (!ok) { controller.close(); return; }
                    }

                    // Step 2: Detect cuDNN version via torch
                    const cudnnVersion = await detectCudnnViaTorch();

                    // Step 3: Select the best paddlepaddle CUDA tag based on cuDNN
                    const cudaTag = selectCompatibleCudaTag(cudaClamped, cudnnVersion);

                    if (cudaTag !== detectedTag) {
                         console.log(`[PaddleOCR] CUDA ${detectedTag} → using build: ${cudaTag}${
                              cudnnVersion ? ` (system CUDNN ${cudnnVersion})` : ""
                         }`);
                    }

                    send({
                         type: "cuda",
                         version: cudaTag,
                         detectedVersion: detectedTag,
                         cudnnVersion: cudnnVersion ?? "unknown",
                    });

                    // Step 4: Install paddlepaddle-gpu with the version for the selected tag
                    const paddleURL = PADDLE_INDEX_URL_FOR_TAG[cudaTag] ?? `https://www.paddlepaddle.org.cn/packages/stable/${cudaTag}/`;
                    const paddleVersion = PADDLE_VERSION_FOR_TAG[cudaTag];
                    const paddleSpec = paddleVersion
                         ? `paddlepaddle-gpu==${paddleVersion}`
                         : "paddlepaddle-gpu";

                    const paddleArgs = [
                         "install",
                         paddleSpec,
                         "--extra-index-url",
                         paddleURL,
                         // Upgrade to ensure we replace any older installed version
                         "--upgrade",
                         // nightly and cu123 indexes only carry pre-release builds
                         ...(PADDLE_PRE_TAGS.has(cudaTag) ? ["--pre"] : []),
                    ];

                    const ok1 = await runCommand("pip", paddleArgs);
                    if (!ok1) { controller.close(); return; }

                    // Step 5: Install paddleocr
                    const ok2 = await runCommand("pip", ["install", "paddleocr[doc-parser]"]);
                    if (!ok2) { controller.close(); return; }

                    // Step 6: Remove pip-installed nvidia-cudnn packages.
                    // torch brings in nvidia-cudnn-cu* whose cuDNN DLLs can be
                    // incompatible with paddlepaddle-gpu, causing WinError 127
                    // ("The specified procedure could not be found") at import time.
                    // Both torch and paddle will fall back to the system cuDNN
                    // (already verified compatible via torch.backends.cudnn).
                    await runCommand("pip", [
                         "uninstall", "-y",
                         "nvidia-cudnn-cu11", "nvidia-cudnn-cu12",
                    ]);

                    send({ type: "done" });
                    controller.close();
               };

               runPipeline().catch((err) => {
                    console.error("[PaddleOCR] Pipeline error:", err);
                    send({ type: "error", message: err instanceof Error ? err.message : String(err) });
                    try { controller.close(); } catch { /* already closed */ }
               });
          },
     });

     return new NextResponse(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
     });
}
