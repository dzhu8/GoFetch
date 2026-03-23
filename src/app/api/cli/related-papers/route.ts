import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { eq } from "drizzle-orm";
import configManager from "@/server";
import db from "@/server/db";
import {
     papers,
     relatedPapers,
     relatedRuns,
     paperEdgeCache,
     paperMetadataCache,
     paperAbstractEmbeddings,
     paperSourceLinks,
} from "@/server/db/schema";
import { buildRelatedPapersGraph, GraphConstructionMethod, resolveSeedPaper } from "@/lib/relatedPapers/graph";
import { extractDocumentMetadata } from "@/lib/citations/parseReferences";

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
 * Accepts an absolute path to a local PDF file.  If a `.ocr.json` sidecar
 * already exists alongside the PDF it is reused; otherwise PaddleOCR-VL is
 * invoked and the result is saved as `<name>.ocr.json` next to the PDF.
 *
 * Returns the same RelatedPapersResponse shape as /api/related-papers.
 *
 * ── Request body fields ────────────────────────────────────────────────────
 * Required:
 *   pdfPath          string   Absolute path to the PDF file.
 *
 * Optional:
 *   method           string   Graph construction strategy.
 *                             Values: "snowball" (default)
 *   rankMethod       string   How candidates are scored after graph construction.
 *                             Values:
 *                               "bibliographic" — rank by BC + CC overlap (default)
 *                               "embedding"     — re-rank by abstract embedding similarity
 *   depth            number   Snowball crawl depth (default: config value / 1).
 *   maxPapers        number   Maximum results to return (default: config value / 50).
 *   bcThreshold      number   Minimum bibliographic-coupling score [0, 1] (default: 0).
 *   ccThreshold      number   Minimum co-citation score [0, 1] (default: 0).
 *   embeddingThreshold number Minimum embedding similarity score [0, 1] (default: 0).
 *                             Only applied when rankMethod === "embedding".
 *
 * ── Example cURL commands ──────────────────────────────────────────────────
 *
 * 1. Bibliographic ranking (BC + CC, fast, no embedding model required):
 *    curl -X POST http://localhost:3000/api/cli/related-papers \
 *      -H "Content-Type: application/json" \
 *      -d '{ "pdfPath": "/data/library/paper.pdf", "method": "snowball", "rankMethod": "bibliographic", "depth": 2, "maxPapers": 50 }'
 *
 * 2. Embedding ranking (semantic similarity, requires a configured embedding model):
 *    curl -X POST http://localhost:3000/api/cli/related-papers \
 *      -H "Content-Type: application/json" \
 *      -d '{ "pdfPath": "/data/library/paper.pdf", "method": "snowball", "rankMethod": "embedding", "maxPapers": 50, "embeddingThreshold": 0.3 }'
 */
export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const {
               pdfPath,
               method,
               rankMethod,
               depth,
               maxPapers,
               bcThreshold,
               ccThreshold,
               embeddingThreshold,
          } = body as {
               pdfPath?: string;
               method?: GraphConstructionMethod;
               rankMethod?: "bibliographic" | "embedding";
               depth?: number;
               maxPapers?: number;
               bcThreshold?: number;
               ccThreshold?: number;
               embeddingThreshold?: number;
          };

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

          const activeMethod =
               method ??
               configManager.getConfig(
                    "personalization.graphConstructionMethod",
                    GraphConstructionMethod.Snowball,
               );

          const snowballConfig = {
               depth: depth ?? configManager.getConfig("personalization.snowballDepth"),
               maxPapers: maxPapers ?? configManager.getConfig("personalization.snowballMaxPapers"),
               bcThreshold: bcThreshold ?? configManager.getConfig("personalization.snowballBcThreshold"),
               ccThreshold: ccThreshold ?? configManager.getConfig("personalization.snowballCcThreshold"),
               rankMethod,
               embeddingThreshold,
          };

          const response = await buildRelatedPapersGraph(
               activeMethod,
               pdfTitle,
               pdfDoi,
               snowballConfig,
          );

          return NextResponse.json(response);
     } catch (err) {
          console.error("[CLI Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Failed to build related-papers graph";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}

// ── DELETE /api/cli/related-papers ───────────────────────────────────────────
/**
 * Clear cached related-papers data. Without parameters, erases all four
 * S2-derived cache tables: ranked results, edge data, metadata, and embeddings.
 *
 * Query params:
 *   doi    string  Optional. Scope clearing to a single paper identified by DOI.
 *   scope  string  Optional comma-separated list of caches to clear.
 *                  Choices: "ranked", "edges", "metadata", "embeddings"
 *                  Default: all four.
 *
 * Examples:
 *   # Wipe every S2-derived cache table
 *   curl -X DELETE "http://localhost:3000/api/cli/related-papers"
 *
 *   # Wipe only ranked results (keeps S2 edge/metadata/embedding caches)
 *   curl -X DELETE "http://localhost:3000/api/cli/related-papers?scope=ranked"
 *
 *   # Wipe everything for one paper
 *   curl -X DELETE "http://localhost:3000/api/cli/related-papers?doi=10.1038/s41586-023-06291-2"
 *
 *   # Wipe ranked results + embeddings for one paper
 *   curl -X DELETE "http://localhost:3000/api/cli/related-papers?doi=10.1038/s41586-023-06291-2&scope=ranked,embeddings"
 */
export async function DELETE(req: NextRequest) {
     try {
          const { searchParams } = new URL(req.url);
          const doi = searchParams.get("doi")?.trim() || null;
          const scopeParam = searchParams.get("scope");

          const VALID_SCOPES = ["ranked", "edges", "metadata", "embeddings"] as const;
          type Scope = (typeof VALID_SCOPES)[number];

          const scopes: Set<Scope> = scopeParam
               ? new Set(
                      scopeParam
                           .split(",")
                           .map((s) => s.trim() as Scope)
                           .filter((s): s is Scope => (VALID_SCOPES as readonly string[]).includes(s)),
                 )
               : new Set(VALID_SCOPES);

          if (scopes.size === 0) {
               return NextResponse.json(
                    { error: `Invalid scope. Valid values: ${VALID_SCOPES.join(", ")}` },
                    { status: 400 },
               );
          }

          const cleared: Partial<Record<Scope, boolean>> = {};

          if (doi) {
               // DOI-scoped clear — resolve to S2 ID and local library paper ID.
               const resolved = await resolveSeedPaper(doi, `DOI:${doi}`);
               const s2Id = resolved?.s2Id ?? null;
               const localPaper = s2Id
                    ? (db
                           .select({ id: papers.id })
                           .from(papers)
                           .where(eq(papers.semanticScholarId, s2Id))
                           .get() ?? null)
                    : null;

               if (!s2Id && !localPaper) {
                    return NextResponse.json({
                         cleared: {},
                         note: "Paper not found in Semantic Scholar or local library — nothing to clear.",
                    });
               }

               if (localPaper && scopes.has("ranked")) {
                    db.delete(relatedPapers).where(eq(relatedPapers.paperId, localPaper.id)).run();
                    db.delete(relatedRuns).where(eq(relatedRuns.paperId, localPaper.id)).run();
                    db.delete(paperSourceLinks).where(eq(paperSourceLinks.sourcePaperId, localPaper.id)).run();
                    cleared.ranked = true;
               }
               if (s2Id && scopes.has("edges")) {
                    db.delete(paperEdgeCache).where(eq(paperEdgeCache.paperId, s2Id)).run();
                    cleared.edges = true;
               }
               if (s2Id && scopes.has("metadata")) {
                    db.delete(paperMetadataCache).where(eq(paperMetadataCache.paperId, s2Id)).run();
                    cleared.metadata = true;
               }
               if (s2Id && scopes.has("embeddings")) {
                    db.delete(paperAbstractEmbeddings)
                         .where(eq(paperAbstractEmbeddings.paperId, s2Id))
                         .run();
                    cleared.embeddings = true;
               }
          } else {
               // Global clear — truncate entire cache tables.
               if (scopes.has("ranked")) {
                    db.delete(relatedPapers).run();
                    db.delete(relatedRuns).run();
                    db.delete(paperSourceLinks).run();
                    cleared.ranked = true;
               }
               if (scopes.has("edges")) {
                    db.delete(paperEdgeCache).run();
                    cleared.edges = true;
               }
               if (scopes.has("metadata")) {
                    db.delete(paperMetadataCache).run();
                    cleared.metadata = true;
               }
               if (scopes.has("embeddings")) {
                    db.delete(paperAbstractEmbeddings).run();
                    cleared.embeddings = true;
               }
          }

          return NextResponse.json({ cleared });
     } catch (err) {
          console.error("[CLI Related Papers / DELETE] Error:", err);
          const msg = err instanceof Error ? err.message : "Failed to clear cache";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}

