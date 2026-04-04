"use server";

import configManager from "@/server";
import {
     buildRelatedPapersGraph,
     GraphConstructionMethod,
     resolveSeedPaper,
} from "@/lib/relatedPapers/graph";

export async function buildRelatedPapersGraphAction(
     pdfTitle: string,
     pdfDoi?: string,
     method?: GraphConstructionMethod,
) {
     try {
          if (!pdfTitle) {
               return { error: "pdfTitle is required." };
          }

          const effectiveTitle = pdfTitle || `DOI:${pdfDoi}`;

          // Use method from payload if provided, otherwise fallback to personalization setting, default to Snowball.
          const activeMethod =
               method ??
               configManager.getConfig("personalization.graphConstructionMethod", GraphConstructionMethod.Snowball);

          const snowballConfig = {
               depth: configManager.getConfig("personalization.snowballDepth"),
               maxPapers: configManager.getConfig("personalization.snowballMaxPapers"),
               bcThreshold: configManager.getConfig("personalization.snowballBcThreshold"),
               ccThreshold: configManager.getConfig("personalization.snowballCcThreshold"),
               rankMethod: configManager.getConfig("personalization.graphRankMethod"),
          };

          const response = await buildRelatedPapersGraph(
               activeMethod,
               effectiveTitle,
               pdfDoi,
               snowballConfig,
          );
          return response;
     } catch (err) {
          console.error("[Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return { error: msg };
     }
}

export async function resolvePaperByDoiAction(doi: string, title?: string) {
     try {
          const result = await resolveSeedPaper(doi, title || `DOI:${doi}`);
          if (!result) {
               return { error: "Paper not found on Semantic Scholar." };
          }
          return result;
     } catch (err) {
          console.error("[Related Papers] Error resolving seed:", err);
          return { error: err instanceof Error ? err.message : "Resolution failed" };
     }
}

