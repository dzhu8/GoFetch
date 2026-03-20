import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, relatedPapers } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import configManager from "@/server";
import {
     buildRelatedPapersGraph,
     resolveSeedPaper,
     GraphConstructionMethod,
     type RankedPaper,
} from "@/lib/relatedPapers/graph";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a local relatedPapers DB row back to the RankedPaper shape used by the UI. */
function dbRowToRankedPaper(row: typeof relatedPapers.$inferSelect): RankedPaper {
     let url = "";
     let domain = "";
     if (row.doi) {
          url = `https://doi.org/${row.doi}`;
          domain = "doi.org";
     } else if (row.semanticScholarId) {
          url = `https://www.semanticscholar.org/paper/${row.semanticScholarId}`;
          domain = "semanticscholar.org";
     }

     return {
          paperId: row.semanticScholarId ?? "",
          title: row.title,
          url,
          snippet: row.abstract ?? "",
          authors: row.authors ?? undefined,
          year: row.year ?? undefined,
          venue: row.venue ?? undefined,
          domain,
          isAcademic: true,
          score: row.relevanceScore ?? 0,
          bcScore: row.bcScore ?? 0,
          ccScore: row.ccScore ?? 0,
          depth: row.depth ?? 1,
     };
}

// ── GET /api/cli/related-papers/doi ──────────────────────────────────────────
/**
 * Check whether related-papers results for a given DOI are already cached locally.
 *
 * Query params:
 *   doi     string  Required.  DOI to look up (e.g. 10.1038/s41586-023-06291-2).
 *   method  string  Optional.  "bibliographic" | "embedding" (default: configured).
 *
 * Response 200:
 *   {
 *     resolved: {
 *       s2Id:        string   Semantic Scholar paper ID for the seed paper
 *       title:       string   Canonical title from Semantic Scholar
 *       abstract?:   string
 *       edgesCached: boolean  Whether raw edge data (refs + cits) is already cached
 *     },
 *     localPaper: {           Present when the paper exists in the local library
 *       id:       number
 *       title:    string | null
 *       fileName: string
 *       doi:      string | null
 *       folderId: number
 *     } | null,
 *     rankMethod:    string
 *     cachedMethods: string[]   Which ranking methods have stored results
 *     rankedPapers:  RankedPaper[] | null   null when no stored results exist
 *   }
 *
 * Response 404: { error: "Paper not found on Semantic Scholar." }
 *
 * Example:
 *   curl "http://localhost:3000/api/cli/related-papers/doi?doi=10.1038/s41586-023-06291-2"
 *   curl "http://localhost:3000/api/cli/related-papers/doi?doi=10.1038%2Fs41586-023-06291-2&method=embedding"
 */
export async function GET(req: NextRequest) {
     try {
          const { searchParams } = new URL(req.url);
          const doi = searchParams.get("doi")?.trim();
          if (!doi) {
               return NextResponse.json({ error: "doi query parameter is required." }, { status: 400 });
          }

          const configuredMethod =
               configManager.getConfig("personalization.graphRankMethod") || "bibliographic";
          const requestedMethod = searchParams.get("method") || configuredMethod;

          // Step 1: Resolve DOI → S2 ID (also checks edge cache).
          const resolved = await resolveSeedPaper(doi, `DOI:${doi}`);
          if (!resolved) {
               return NextResponse.json(
                    { error: "Paper not found on Semantic Scholar." },
                    { status: 404 },
               );
          }

          // Step 2: Check whether this paper is in the local library.
          const localPaperRow = db
               .select({
                    id: papers.id,
                    title: papers.title,
                    fileName: papers.fileName,
                    doi: papers.doi,
                    folderId: papers.folderId,
               })
               .from(papers)
               .where(eq(papers.semanticScholarId, resolved.s2Id))
               .get() ?? null;

          if (!localPaperRow) {
               // Paper not in library — we can report edge-cache status but have no stored results.
               return NextResponse.json({
                    resolved,
                    localPaper: null,
                    rankMethod: requestedMethod,
                    cachedMethods: [],
                    rankedPapers: null,
               });
          }

          // Step 3: Fetch cached related-papers rows for this library paper.
          const rows = db
               .select()
               .from(relatedPapers)
               .where(eq(relatedPapers.paperId, localPaperRow.id))
               .all();

          const cachedMethods = Array.from(new Set(rows.map((r) => r.rankMethod)));

          const rowsForMethod = rows.filter((r) => r.rankMethod === requestedMethod);
          const rankedPapers: RankedPaper[] | null =
               rowsForMethod.length > 0
                    ? rowsForMethod
                         .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
                         .map(dbRowToRankedPaper)
                    : null;

          return NextResponse.json({
               resolved,
               localPaper: localPaperRow,
               rankMethod: requestedMethod,
               cachedMethods,
               rankedPapers,
          });
     } catch (err) {
          console.error("[CLI Related Papers DOI / GET] Error:", err);
          const msg = err instanceof Error ? err.message : "Cache lookup failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}

// ── POST /api/cli/related-papers/doi ─────────────────────────────────────────
/**
 * Run the full related-papers pipeline starting from a DOI — no PDF or OCR required.
 * Resolves the DOI to a Semantic Scholar seed paper, then builds the snowball graph.
 *
 * Request body:
 *   Required:
 *     doi                string   DOI of the source paper.
 *
 *   Optional:
 *     method             string   Graph construction strategy. Values: "snowball" (default).
 *     rankMethod         string   "bibliographic" (default) | "embedding"
 *     depth              number   Snowball crawl depth (default: config / 1).
 *     maxPapers          number   Maximum results (default: config / 50).
 *     bcThreshold        number   Min bibliographic-coupling score [0,1] (default: 0).
 *     ccThreshold        number   Min co-citation score [0,1] (default: 0).
 *     embeddingThreshold number   Min embedding similarity [0,1]; only for rankMethod=embedding.
 *
 * Returns the same RelatedPapersResponse shape as /api/related-papers, with the
 * resolved S2 ID embedded as seedPaperId.
 *
 * Example — bibliographic ranking:
 *   curl -X POST http://localhost:3000/api/cli/related-papers/doi \
 *     -H "Content-Type: application/json" \
 *     -d '{ "doi": "10.1038/s41586-023-06291-2", "depth": 2, "maxPapers": 50 }'
 *
 * Example — embedding ranking:
 *   curl -X POST http://localhost:3000/api/cli/related-papers/doi \
 *     -H "Content-Type: application/json" \
 *     -d '{ "doi": "10.1038/s41586-023-06291-2", "rankMethod": "embedding", "embeddingThreshold": 0.3 }'
 *
 * Example — skip Phase 1 if you already have the S2 ID from a prior GET:
 *   (pass seedPaperS2Id alongside doi to avoid a redundant S2 API call)
 *   curl -X POST http://localhost:3000/api/cli/related-papers/doi \
 *     -H "Content-Type: application/json" \
 *     -d '{ "doi": "10.1038/s41586-023-06291-2", "seedPaperS2Id": "abc123..." }'
 */
export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const {
               doi,
               method,
               rankMethod,
               depth,
               maxPapers,
               bcThreshold,
               ccThreshold,
               embeddingThreshold,
               seedPaperS2Id: bodyS2Id,
          } = body as {
               doi?: string;
               method?: GraphConstructionMethod;
               rankMethod?: "bibliographic" | "embedding";
               depth?: number;
               maxPapers?: number;
               bcThreshold?: number;
               ccThreshold?: number;
               embeddingThreshold?: number;
               /** Optional: pre-resolved S2 ID from a prior GET call — skips Phase 1. */
               seedPaperS2Id?: string;
          };

          if (!doi || typeof doi !== "string") {
               return NextResponse.json({ error: "doi is required." }, { status: 400 });
          }

          // Resolve the DOI first so we can pass the known S2 ID to the graph builder,
          // skipping Phase 1 entirely.  If the caller already provided a seedPaperS2Id
          // (e.g. obtained from a prior GET call) we skip the resolution API call too.
          let resolvedS2Id = bodyS2Id ?? null;
          let resolvedTitle: string | undefined;

          if (!resolvedS2Id) {
               const resolved = await resolveSeedPaper(doi, `DOI:${doi}`);
               if (!resolved) {
                    return NextResponse.json(
                         { error: "Paper not found on Semantic Scholar. Check the DOI." },
                         { status: 404 },
                    );
               }
               resolvedS2Id = resolved.s2Id;
               resolvedTitle = resolved.title;
          }

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
               seedPaperS2Id: resolvedS2Id,
          };

          const response = await buildRelatedPapersGraph(
               activeMethod,
               resolvedTitle ?? `DOI:${doi}`,
               doi,
               snowballConfig,
          );

          return NextResponse.json(response);
     } catch (err) {
          console.error("[CLI Related Papers DOI / POST] Error:", err);
          const msg = err instanceof Error ? err.message : "Failed to build related-papers graph";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
