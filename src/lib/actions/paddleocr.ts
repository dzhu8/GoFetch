"use server";

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import configManager from "@/server";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// PaddleOCR Models
// ---------------------------------------------------------------------------

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

export async function getPaddleOCRModels() {
     try {
          const installed = await isPaddleOCRInstalled();

          const models = PADDLEOCR_CURATED_MODELS.map((m) => ({
               ...m,
               installed,
               supportsOCR: true,
               supportsChat: false,
               supportsEmbedding: false,
          }));

          return { models };
     } catch (error) {
          return { error: error instanceof Error ? error.message : "Failed to check PaddleOCR status" };
     }
}

// ---------------------------------------------------------------------------
// Python Environments
// ---------------------------------------------------------------------------

export type PythonEnvironment = {
     name: string;
     pythonPath: string;
     version: string;
     type: "system" | "conda" | "venv";
};

async function getPythonVersion(pythonExe: string): Promise<string | null> {
     try {
          const { stdout, stderr } = await execFileAsync(pythonExe, ["--version"], { timeout: 5000 });
          const output = (stdout + stderr).trim();
          const match = output.match(/Python\s+([\d.]+)/i);
          return match ? match[1] : null;
     } catch {
          return null;
     }
}

async function resolveExecutablePath(candidate: string): Promise<string> {
     try {
          const which = process.platform === "win32" ? "where" : "which";
          const { stdout } = await execFileAsync(which, [candidate], { timeout: 3000 });
          const first = stdout.trim().split(/[\r\n]+/)[0]?.trim();
          return first || candidate;
     } catch {
          return candidate;
     }
}

async function detectSystemPython(): Promise<PythonEnvironment[]> {
     const candidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
     const seen = new Set<string>();
     const results: PythonEnvironment[] = [];

     for (const candidate of candidates) {
          const version = await getPythonVersion(candidate);
          if (!version) continue;

          const pythonPath = await resolveExecutablePath(candidate);
          const key = pythonPath.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          results.push({
               name: `System Python ${version}`,
               pythonPath,
               version,
               type: "system",
          });
     }
     return results;
}

async function detectCondaEnvs(): Promise<PythonEnvironment[]> {
     try {
          const { stdout } = await execFileAsync("conda", ["env", "list", "--json"], { timeout: 10000 });
          const data: { envs?: string[] } = JSON.parse(stdout);
          const envPaths = data.envs ?? [];

          const results: PythonEnvironment[] = [];
          for (const envPath of envPaths) {
               const pythonExe =
                    process.platform === "win32"
                         ? path.join(envPath, "python.exe")
                         : path.join(envPath, "bin", "python");

               if (!fs.existsSync(pythonExe)) continue;

               const version = await getPythonVersion(pythonExe);
               if (!version) continue;

               const baseName = path.basename(envPath);
               // Named envs live under <conda_root>/envs/<name>; the base env is the root itself.
               const isBase = !envPath.includes(`${path.sep}envs${path.sep}`) && !envPath.includes("/envs/");

               results.push({
                    name: isBase ? `conda: base (${version})` : `conda: ${baseName} (${version})`,
                    pythonPath: pythonExe,
                    version,
                    type: "conda",
               });
          }
          return results;
     } catch {
          return [];
     }
}

export async function getPythonEnvironments() {
     const [systemEnvs, condaEnvs] = await Promise.all([detectSystemPython(), detectCondaEnvs()]);
     const environments: PythonEnvironment[] = [...systemEnvs, ...condaEnvs];
     return { environments };
}

export async function createPythonEnvironment(venvPath: string, basePython?: string) {
     try {
          const effectiveBasePython = basePython || "python";

          if (!venvPath || typeof venvPath !== "string" || !venvPath.trim()) {
               return { error: "venvPath is required" };
          }

          // Resolve and validate — reject traversal attempts
          const resolved = path.resolve(venvPath.trim());

          const created = await new Promise<boolean>((resolve) => {
               const proc = spawn(effectiveBasePython, ["-m", "venv", resolved]);
               proc.on("close", (code) => resolve(code === 0));
               proc.on("error", () => resolve(false));
          });

          if (!created) {
               return {
                    error: "Failed to create virtual environment. Make sure the base Python has the venv module available.",
               };
          }

          const pythonExe =
               process.platform === "win32"
                    ? path.join(resolved, "Scripts", "python.exe")
                    : path.join(resolved, "bin", "python");

          const version = await getPythonVersion(pythonExe);

          const environment: PythonEnvironment = {
               name: `venv: ${path.basename(resolved)} (${version ?? "unknown"})`,
               pythonPath: pythonExe,
               version: version ?? "unknown",
               type: "venv",
          };

          return { environment };
     } catch {
          return { error: "Invalid request body" };
     }
}
