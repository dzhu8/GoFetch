import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import db from "@/server/db";
import {
     paperMetadataCache,
     doiRelatedResultsCache,
     papers,
     relatedPapers,
} from "@/server/db/schema";
import { resolveSeedPaper, type RankedPaper } from "@/lib/relatedPapers/graph";
import configManager from "@/server";

/** Convert a local relatedPapers DB row back to the RankedPaper shape. */
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

// ── GET /api/cli/related-papers/results ──────────────────────────────────────
/**
 * Retrieve cached related-papers results by DOI, Semantic Scholar ID, or title.
 * Does NOT trigger a new computation — returns only previously computed results.
 *
 * Query params (provide exactly one):
 *   doi    string   DOI (e.g. 10.1038/s41586-023-06291-2)
 *   s2id   string   Semantic Scholar paper ID
 *   title  string   Paper title (fuzzy-matched via Semantic Scholar)
 *
 * Optional:
 *   method string   "bibliographic" | "embedding" (default: configured)
 *
 * Response 200 (results exist):
 *   {
 *     s2Id:         string
 *     seedTitle:    string | null
 *     rankMethod:   string
 *     rankedPapers: RankedPaper[]
 *   }
 *
 * Response 200 (no results):
 *   {
 *     s2Id:         string
 *     seedTitle:    string | null
 *     rankMethod:   string
 *     rankedPapers: null
 *     message:      string
 *   }
 *
 * Response 404: { error: "..." }
 *
 * Examples:
 *   curl "http://localhost:3000/api/cli/related-papers/results?doi=10.1038/s41586-023-06291-2"
 *   curl "http://localhost:3000/api/cli/related-papers/results?s2id=abc123&method=embedding"
 *   curl "http://localhost:3000/api/cli/related-papers/results?title=Attention+Is+All+You+Need"
 */
export async function GET(req: NextRequest) {
     try {
          const { searchParams } = new URL(req.url);
          const doi = searchParams.get("doi")?.trim() || null;
          const s2id = searchParams.get("s2id")?.trim() || null;
          const title = searchParams.get("title")?.trim() || null;

          if (!doi && !s2id && !title) {
               return NextResponse.json(
                    { error: "Provide one of: doi, s2id, or title as a query parameter." },
                    { status: 400 },
               );
          }

          const configuredMethod =
               configManager.getConfig("personalization.graphRankMethod") || "bibliographic";
          const rankMethod = searchParams.get("method") || configuredMethod;

          // Resolve the identifier to an S2 ID
          let s2Id: string | null = null;
          let seedTitle: string | null = null;

          if (s2id) {
               s2Id = s2id;
               const cached = db
                    .select({ title: paperMetadataCache.title })
                    .from(paperMetadataCache)
                    .where(eq(paperMetadataCache.paperId, s2id))
                    .get();
               seedTitle = cached?.title ?? null;
          } else {
               const resolved = await resolveSeedPaper(doi ?? undefined, title ?? `DOI:${doi}`);
               if (!resolved) {
                    return NextResponse.json(
                         { error: "Paper not found on Semantic Scholar." },
                         { status: 404 },
                    );
               }
               s2Id = resolved.s2Id;
               seedTitle = resolved.title;
          }

          // Check the DOI-based results cache first
          const doiRow = db
               .select()
               .from(doiRelatedResultsCache)
               .where(eq(doiRelatedResultsCache.s2PaperId, s2Id))
               .all()
               .find((r) => r.rankMethod === rankMethod);

          if (doiRow) {
               return NextResponse.json({
                    s2Id,
                    seedTitle: doiRow.seedTitle ?? seedTitle,
                    rankMethod,
                    rankedPapers: JSON.parse(doiRow.resultsJson) as RankedPaper[],
               });
          }

          // Check the library-based relatedPapers table
          const localPaper = db
               .select({ id: papers.id, title: papers.title })
               .from(papers)
               .where(eq(papers.semanticScholarId, s2Id))
               .get();

          if (localPaper) {
               const rows = db
                    .select()
                    .from(relatedPapers)
                    .where(eq(relatedPapers.paperId, localPaper.id))
                    .all()
                    .filter((r) => r.rankMethod === rankMethod);

               if (rows.length > 0) {
                    return NextResponse.json({
                         s2Id,
                         seedTitle: localPaper.title ?? seedTitle,
                         rankMethod,
                         rankedPapers: rows
                              .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
                              .map(dbRowToRankedPaper),
                    });
               }
          }

          // No results found
          return NextResponse.json({
               s2Id,
               seedTitle,
               rankMethod,
               rankedPapers: null,
               message: "No related-papers results found for this paper. Run a POST request to compute them first.",
          });
     } catch (err) {
          console.error("[CLI Related Papers Results / GET] Error:", err);
          const msg = err instanceof Error ? err.message : "Results lookup failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
