import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import db from "@/server/db";
import { paperMetadataCache, doiRelatedResultsCache } from "@/server/db/schema";
import { resolveSeedPaper } from "@/lib/relatedPapers/graph";

// ── GET /api/cli/related-papers/info ─────────────────────────────────────────
/**
 * Look up a paper's title and abstract by DOI, Semantic Scholar ID, or title.
 * If the paper has not been processed through POST yet, indicates so.
 *
 * Query params (provide exactly one):
 *   doi    string   DOI (e.g. 10.1038/s41586-023-06291-2)
 *   s2id   string   Semantic Scholar paper ID
 *   title  string   Paper title (fuzzy-matched via Semantic Scholar)
 *
 * Response 200:
 *   {
 *     s2Id:       string
 *     title:      string
 *     abstract:   string | null
 *     processed:  boolean          Whether related-papers have been computed via POST
 *   }
 *
 * Response 404: { error: "..." }
 *
 * Examples:
 *   curl "http://localhost:3000/api/cli/related-papers/info?doi=10.1038/s41586-023-06291-2"
 *   curl "http://localhost:3000/api/cli/related-papers/info?s2id=abc123"
 *   curl "http://localhost:3000/api/cli/related-papers/info?title=Attention+Is+All+You+Need"
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

          let s2Id: string | null = null;
          let paperTitle: string | null = null;
          let paperAbstract: string | null = null;

          if (s2id) {
               // Direct lookup in metadata cache first
               const cached = db
                    .select({ title: paperMetadataCache.title, abstract: paperMetadataCache.abstract })
                    .from(paperMetadataCache)
                    .where(eq(paperMetadataCache.paperId, s2id))
                    .get();

               if (cached) {
                    s2Id = s2id;
                    paperTitle = cached.title;
                    paperAbstract = cached.abstract;
               } else {
                    // Not in cache — resolve via S2 API using the ID as a title hint
                    // (resolveSeedPaper will try DOI first, then title match)
                    const resolved = await resolveSeedPaper(undefined, s2id);
                    if (!resolved) {
                         return NextResponse.json(
                              { error: "Paper not found in local cache or on Semantic Scholar." },
                              { status: 404 },
                         );
                    }
                    s2Id = resolved.s2Id;
                    paperTitle = resolved.title;
                    paperAbstract = resolved.abstract ?? null;
               }
          } else {
               // Resolve via DOI or title through S2
               const resolved = await resolveSeedPaper(doi ?? undefined, title ?? `DOI:${doi}`);
               if (!resolved) {
                    return NextResponse.json(
                         { error: "Paper not found on Semantic Scholar." },
                         { status: 404 },
                    );
               }
               s2Id = resolved.s2Id;
               paperTitle = resolved.title;
               paperAbstract = resolved.abstract ?? null;
          }

          // Check whether this paper has been processed (has results in doiRelatedResultsCache)
          const hasResults = db
               .select({ s2PaperId: doiRelatedResultsCache.s2PaperId })
               .from(doiRelatedResultsCache)
               .where(eq(doiRelatedResultsCache.s2PaperId, s2Id))
               .get();

          return NextResponse.json({
               s2Id,
               title: paperTitle,
               abstract: paperAbstract,
               processed: !!hasResults,
          });
     } catch (err) {
          console.error("[CLI Related Papers Info / GET] Error:", err);
          const msg = err instanceof Error ? err.message : "Lookup failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
