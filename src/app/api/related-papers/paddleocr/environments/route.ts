import { NextRequest, NextResponse } from "next/server";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

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

export async function GET() {
     const [systemEnvs, condaEnvs] = await Promise.all([detectSystemPython(), detectCondaEnvs()]);
     const environments: PythonEnvironment[] = [...systemEnvs, ...condaEnvs];
     return NextResponse.json({ environments });
}

export async function POST(req: NextRequest) {
     try {
          const body = await req.json() as { venvPath?: string; basePython?: string };
          const { venvPath, basePython = "python" } = body;

          if (!venvPath || typeof venvPath !== "string" || !venvPath.trim()) {
               return NextResponse.json({ error: "venvPath is required" }, { status: 400 });
          }

          // Resolve and validate — reject traversal attempts
          const resolved = path.resolve(venvPath.trim());

          const created = await new Promise<boolean>((resolve) => {
               const proc = spawn(basePython, ["-m", "venv", resolved]);
               proc.on("close", (code) => resolve(code === 0));
               proc.on("error", () => resolve(false));
          });

          if (!created) {
               return NextResponse.json(
                    { error: "Failed to create virtual environment. Make sure the base Python has the venv module available." },
                    { status: 500 }
               );
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

          return NextResponse.json({ environment });
     } catch {
          return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
     }
}
