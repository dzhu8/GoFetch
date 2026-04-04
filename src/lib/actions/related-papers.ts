"use server";

import configManager from "@/server";
import {
     buildRelatedPapersGraph,
     GraphConstructionMethod,
} from "@/lib/relatedPapers/graph";

export async function buildRelatedPapersGraphAction(
     pdfTitle: string,
     pdfDoi?: string,
     method?: GraphConstructionMethod,
) {
     try {
<<<<<<< Updated upstream:src/app/api/related-papers/route.ts
          const body = await req.json();
          const { pdfTitle, pdfDoi, method, seedPaperS2Id, stream = false } = body as {
               pdfTitle?: string;
               pdfDoi?: string;
               method?: GraphConstructionMethod;
               /** Pre-resolved Semantic Scholar paper ID — skips Phase 1 resolution entirely. */
               seedPaperS2Id?: string;
               /** Whether to stream progress updates via NDJSON. Defaults to false. */
               stream?: boolean;
          };

          if (!pdfTitle && !pdfDoi && !seedPaperS2Id) {
               return NextResponse.json({ error: "pdfTitle, pdfDoi, or seedPaperS2Id is required." }, { status: 400 });
=======
          if (!pdfTitle) {
               return { error: "pdfTitle is required." };
>>>>>>> Stashed changes:src/lib/actions/related-papers.ts
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
               rankMethod: configManager.getConfig("personalization.graphRankMethod"),
               seedPaperS2Id,
          };

          if (!stream) {
               const response = await buildRelatedPapersGraph(
                    activeMethod,
                    effectiveTitle,
                    pdfDoi,
                    snowballConfig,
               );
               return NextResponse.json(response);
          }

<<<<<<< Updated upstream:src/app/api/related-papers/route.ts
          // Streaming implementation using TransformStream
          const encoder = new TextEncoder();
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();

          const send = async (data: any) => {
               await writer.write(encoder.encode(JSON.stringify(data) + "\n"));
          };

          // Run graph construction in the background
          (async () => {
               try {
                    const result = await buildRelatedPapersGraph(
                         activeMethod,
                         effectiveTitle,
                         pdfDoi,
                         {
                              ...snowballConfig,
                              onProgress: async (update) => {
                                   await send({ type: "progress", ...update });
                              },
                         },
                    );
                    await send({ type: "result", ...result });
               } catch (err: any) {
                    await send({ type: "error", message: err.message || "Execution error" });
               } finally {
                    await writer.close();
               }
          })();

          return new NextResponse(readable, {
               headers: {
                    "Content-Type": "application/x-ndjson",
                    "Cache-Control": "no-cache",
               },
          });
=======
          return response;
>>>>>>> Stashed changes:src/lib/actions/related-papers.ts
     } catch (err) {
          console.error("[Related Papers] Error:", err);
          const msg = err instanceof Error ? err.message : "Search failed";
          return { error: msg };
     }
}

