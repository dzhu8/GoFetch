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
          const { pdfTitle, pdfDoi, method, seedPaperS2Id } = body as {
               pdfTitle?: string;
               pdfDoi?: string;
               method?: GraphConstructionMethod;
               /** Pre-resolved Semantic Scholar paper ID — skips Phase 1 resolution entirely. */
               seedPaperS2Id?: string;
          };

          if (!pdfTitle && !pdfDoi && !seedPaperS2Id) {
               return NextResponse.json({ error: "pdfTitle, pdfDoi, or seedPaperS2Id is required." }, { status: 400 });
          }

          const effectiveTitle = pdfTitle || `DOI:${pdfDoi}` || `S2:${seedPaperS2Id}`;

          // Use method from payload if provided, otherwise fallback to personalization setting, default to Snowball.
          const activeMethod =
               method ??
               configManager.getConfig("personalization.graphConstructionMethod", GraphConstructionMethod.Snowball);

          const snowballConfig = {
               depth: configManager.getConfig("personalization.snowballDepth"),
               maxPapers: configManager.getConfig("personalization.snowballMaxPapers"),
               bcThreshold: configManager.getConfig("personalization.snowballBcThreshold"),
               ccThreshold: configManager.getConfig("personalization.snowballCcThreshold"),
               seedPaperS2Id,
          };

          const response = await buildRelatedPapersGraph(
               activeMethod,
               effectiveTitle,
               pdfDoi,
               snowballConfig,
          );

          return NextResponse.json(response);
     } catch (err) {
          console.error("[Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
