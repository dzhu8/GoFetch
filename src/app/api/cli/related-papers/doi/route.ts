import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { doiRelatedResultsCache } from "@/server/db/schema";
import configManager from "@/server";
import {
     buildRelatedPapersGraph,
     resolveSeedPaper,
     GraphConstructionMethod,
} from "@/lib/relatedPapers/graph";

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
 *
 * Example — stream progress (NDJSON):
 *   curl -X POST http://localhost:3000/api/cli/related-papers/doi \
 *     -H "Content-Type: application/json" \
 *     -d '{ "doi": "10.1038/s41586-023-06291-2", "stream": true }' --no-buffer
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
               stream = false,
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
               /** Whether to stream progress updates via NDJSON. Defaults to false. */
               stream?: boolean;
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

          if (!stream) {
               const response = await buildRelatedPapersGraph(
                    activeMethod,
                    resolvedTitle ?? `DOI:${doi}`,
                    doi,
                    snowballConfig,
               );

               // Persist results so the GET endpoint can retrieve them later.
               if (resolvedS2Id && response.rankedPapers?.length) {
                    db.insert(doiRelatedResultsCache)
                         .values({
                              s2PaperId: resolvedS2Id,
                              doi,
                              rankMethod: response.rankMethod ?? "bibliographic",
                              resultsJson: JSON.stringify(response.rankedPapers),
                              seedTitle: resolvedTitle ?? null,
                              embeddingModel: response.embeddingModel ?? null,
                              createdAt: Date.now(),
                         })
                         .onConflictDoUpdate({
                              target: [doiRelatedResultsCache.s2PaperId, doiRelatedResultsCache.rankMethod],
                              set: {
                                   doi,
                                   resultsJson: JSON.stringify(response.rankedPapers),
                                   seedTitle: resolvedTitle ?? null,
                                   embeddingModel: response.embeddingModel ?? null,
                                   createdAt: Date.now(),
                              },
                         })
                         .run();
               }

               return NextResponse.json(response);
          }

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
                         resolvedTitle ?? `DOI:${doi}`,
                         doi,
                         {
                              ...snowballConfig,
                              onProgress: async (update) => {
                                   await send({ type: "progress", ...update });
                              },
                         },
                    );

                    // Persist streamed results so the GET endpoint can retrieve them later.
                    if (resolvedS2Id && result.rankedPapers?.length) {
                         db.insert(doiRelatedResultsCache)
                              .values({
                                   s2PaperId: resolvedS2Id,
                                   doi,
                                   rankMethod: result.rankMethod ?? "bibliographic",
                                   resultsJson: JSON.stringify(result.rankedPapers),
                                   seedTitle: resolvedTitle ?? null,
                                   embeddingModel: result.embeddingModel ?? null,
                                   createdAt: Date.now(),
                              })
                              .onConflictDoUpdate({
                                   target: [doiRelatedResultsCache.s2PaperId, doiRelatedResultsCache.rankMethod],
                                   set: {
                                        doi,
                                        resultsJson: JSON.stringify(result.rankedPapers),
                                        seedTitle: resolvedTitle ?? null,
                                        embeddingModel: result.embeddingModel ?? null,
                                        createdAt: Date.now(),
                                   },
                              })
                              .run();
                    }

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
     } catch (err) {
          console.error("[CLI Related Papers DOI / POST] Error:", err);
          const msg = err instanceof Error ? err.message : "Failed to build related-papers graph";
          return NextResponse.json({ error: msg }, { status: 500 });
     }
}
