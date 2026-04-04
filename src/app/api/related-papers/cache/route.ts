import { NextResponse } from "next/server";
import { getCachedPapers } from "@/lib/relatedPapers/graph";

/**
 * GET /api/related-papers/cache
 * 
 * Returns the Semantic Scholar ID and Title of every paper currently 
 * in the local metadata cache.
 */
export async function GET() {
     try {
          const papers = await getCachedPapers();
          return NextResponse.json({ papers });
     } catch (err) {
          console.error("[Related Papers Cache] GET Error:", err);
          return NextResponse.json({ error: "Failed to retrieve cache." }, { status: 500 });
     }
}
