import { NextRequest, NextResponse } from "next/server";
import configManager from "@/server";
import {
     buildRelatedPapersGraph,
     GraphConstructionMethod,
     type RankedPaper,
     type RelatedPapersResponse,
} from "@/lib/relatedPapers/graph";

export type { RankedPaper, RelatedPapersResponse, GraphConstructionMethod };

export async function POST(req: NextRequest) {
     try {
          const body = await req.json();
          const { terms, isDoiFlags, pdfTitle, pdfDoi, method } = body as {
               terms: string[];
               isDoiFlags: boolean[];
               pdfTitle: string;
               pdfDoi?: string;
               method?: GraphConstructionMethod;
          };

          if (!terms?.length) {
               return NextResponse.json({ error: "No search terms provided." }, { status: 400 });
          }

          // Use method from payload if provided, otherwise fallback to personalization setting, default to Snowball.
          const activeMethod =
               method ??
               configManager.getConfig("personalization.graphConstructionMethod", GraphConstructionMethod.Snowball);

          const response = await buildRelatedPapersGraph(activeMethod, terms, isDoiFlags, pdfTitle, pdfDoi);

          return NextResponse.json(response);
     } catch (err) {
          console.error("[Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
