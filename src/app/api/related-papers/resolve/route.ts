import { NextRequest, NextResponse } from "next/server";
import { resolveSeedPaper } from "@/lib/relatedPapers/graph";

/**
 * GET /api/related-papers/resolve
 *
 * Resolves a DOI and/or title to a Semantic Scholar paper ID without running the
 * full snowball graph expansion.  Useful for the frontend to confirm a paper
 * exists and check whether edge data is already cached before committing to a
 * potentially long crawl.
 *
 * Query params:
 *   doi    string  (optional)  DOI to look up (preferred over title when both supplied).
 *   title  string  (optional)  Paper title to fuzzy-match against.
 *
 * At least one of doi or title is required.
 *
 * Response (200):
 *   {
 *     s2Id:        string   Semantic Scholar paper ID
 *     title:       string   Canonical title from Semantic Scholar
 *     abstract?:   string   Abstract (if available)
 *     edgesCached: boolean  true if reference + citation edge data is already in the
 *                           local cache (indicating a prior full run exists)
 *   }
 *
 * Response (404): { error: "Paper not found on Semantic Scholar." }
 */
export async function GET(req: NextRequest) {
     try {
          const { searchParams } = new URL(req.url);
          const doi = searchParams.get("doi")?.trim() || undefined;
          const title = searchParams.get("title")?.trim() || "";

          if (!doi && !title) {
               return NextResponse.json(
                    { error: "At least one of doi or title is required." },
                    { status: 400 },
               );
          }

          const result = await resolveSeedPaper(doi, title || `DOI:${doi}`);

          if (!result) {
               return NextResponse.json(
                    { error: "Paper not found on Semantic Scholar." },
                    { status: 404 },
               );
          }

          return NextResponse.json(result);
     } catch (err) {
          console.error("[Resolve Seed] Error:", err);
          const msg = err instanceof Error ? err.message : "Seed resolution failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
