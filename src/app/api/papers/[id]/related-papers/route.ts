import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, relatedPapers } from "@/server/db/schema";
import { and, eq } from "drizzle-orm";
import fs from "fs";
import { extractDocumentMetadata } from "@/lib/citations/parseReferences";
import configManager from "@/server";
import { buildRelatedPapersGraph, GraphConstructionMethod } from "@/lib/relatedPapers/graph";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/papers/[id]/related-papers?method=bibliographic|embedding
 * Fetch saved related papers for the given method (defaults to current config).
 * Also returns which methods have cached results so the UI can show stale indicators.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const configuredMethod = configManager.getConfig("personalization.graphRankMethod") || "bibliographic";
          const requestedMethod = req.nextUrl.searchParams.get("method") || configuredMethod;

          // Fetch results for the requested method
          const results = db
               .select()
               .from(relatedPapers)
               .where(and(eq(relatedPapers.paperId, paperId), eq(relatedPapers.rankMethod, requestedMethod)))
               .all();

          // Check which methods have cached results
          const allResults = db
               .select({ rankMethod: relatedPapers.rankMethod, embeddingModel: relatedPapers.embeddingModel })
               .from(relatedPapers)
               .where(eq(relatedPapers.paperId, paperId))
               .all();

          const cachedMethods = new Set(allResults.map((r) => r.rankMethod));
          const cachedEmbeddingModel = allResults.find((r) => r.rankMethod === "embedding")?.embeddingModel ?? null;

          // Check if the cached embedding results were produced by the current model
          const currentModel = configManager.getConfig("preferences.defaultEmbeddingModel");
          const currentModelKey = typeof currentModel === "object" ? currentModel?.modelKey : null;
          const embeddingResultsStale = cachedMethods.has("embedding") && cachedEmbeddingModel !== currentModelKey;

          return NextResponse.json({
               relatedPapers: results,
               rankMethod: requestedMethod,
               configuredMethod,
               cachedMethods: Array.from(cachedMethods),
               embeddingResultsStale,
          });
     } catch (error) {
          console.error("Error fetching related papers:", error);
          return NextResponse.json({ error: "Failed to fetch related papers" }, { status: 500 });
     }
}

/**
 * POST /api/papers/[id]/related-papers
 * Recompute and save related papers for a given paper.
 */
export async function POST(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperIdValue = parseInt(id, 10);
          if (isNaN(paperIdValue)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          // 1. Get paper info from DB
          const paper = db.select().from(papers).where(eq(papers.id, paperIdValue)).get();
          if (!paper) {
               return NextResponse.json({ error: "Paper not found" }, { status: 404 });
          }

          // 2. Locate OCR result
          const ocrPath = paper.filePath.replace(/\.pdf$/i, ".ocr.json");
          if (!fs.existsSync(ocrPath)) {
               // If no OCR exists, we can't extract references to build a graph
               return NextResponse.json(
                    { error: "Paper OCR not found. Please ensure paper is processed first." },
                    { status: 422 }
               );
          }

          const ocrResult = JSON.parse(fs.readFileSync(ocrPath, "utf-8"));
          const meta = extractDocumentMetadata(ocrResult);
          const pdfTitle = meta.title ?? paper.title ?? paper.fileName;
          const pdfDoi = meta.doi ?? paper.doi ?? undefined;

          // 3. Build the graph
          const method = configManager.getConfig(
               "personalization.graphConstructionMethod",
               GraphConstructionMethod.Snowball
          );

          const snowballConfig = {
               depth: configManager.getConfig("personalization.snowballDepth"),
               maxPapers: configManager.getConfig("personalization.snowballMaxPapers"),
               bcThreshold: configManager.getConfig("personalization.snowballBcThreshold"),
               ccThreshold: configManager.getConfig("personalization.snowballCcThreshold"),
               // Pass the known S2 ID so Phase 1 (API seed lookup) can be skipped.
               seedPaperS2Id: paper.semanticScholarId ?? undefined,
          };

          const response = await buildRelatedPapersGraph(
               method,
               pdfTitle,
               pdfDoi,
               snowballConfig
          );

          // Persist a newly resolved S2 ID back to the papers table so future runs skip Phase 1.
          if (response.seedPaperId && !paper.semanticScholarId) {
               db.update(papers)
                    .set({ semanticScholarId: response.seedPaperId })
                    .where(eq(papers.id, paperIdValue))
                    .run();
               console.log(`[POST] Saved seed S2 ID ${response.seedPaperId} for paper #${paperIdValue}`);
          }

          // 4. Save to database — replace only rows for this rank method, preserving the other method's results
          db.transaction((tx) => {
               tx.delete(relatedPapers)
                    .where(and(eq(relatedPapers.paperId, paperIdValue), eq(relatedPapers.rankMethod, response.rankMethod)))
                    .run();

               for (const rp of response.rankedPapers) {
                    // Extract DOI from the URL when it's a doi.org link
                    const doiMatch = rp.url.match(/^https:\/\/doi\.org\/(.+)$/);
                    const doi = doiMatch ? decodeURIComponent(doiMatch[1]) : null;
                    tx.insert(relatedPapers).values({
                         paperId: paperIdValue,
                         title: rp.title,
                         authors: rp.authors || null,
                         year: rp.year || null,
                         venue: rp.venue || null,
                         abstract: rp.snippet || null,
                         doi,
                         semanticScholarId: rp.paperId || null,
                         relevanceScore: rp.score,
                         bcScore: rp.bcScore,
                         ccScore: rp.ccScore,
                         rankMethod: response.rankMethod,
                         embeddingModel: response.embeddingModel ?? null,
                    }).run();
               }
          });

          return NextResponse.json({
               success: true,
               pdfTitle,
               rankedPapers: response.rankedPapers,
          });
     } catch (error) {
          console.error("Error computing related papers:", error);
          return NextResponse.json({ error: "Failed to compute related papers" }, { status: 500 });
     }
}
