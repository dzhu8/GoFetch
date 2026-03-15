import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers, relatedPapers } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import { parseReferences, extractDocumentMetadata } from "@/lib/citations/parseReferences";
import configManager from "@/server";
import { buildRelatedPapersGraph, GraphConstructionMethod } from "@/lib/relatedPapers/graph";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/papers/[id]/related-papers
 * Fetch saved related papers from the database.
 */
export async function GET(_req: NextRequest, { params }: RouteParams) {
     try {
          const { id } = await params;
          const paperId = parseInt(id, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paper ID" }, { status: 400 });
          }

          const results = db
               .select()
               .from(relatedPapers)
               .where(eq(relatedPapers.paperId, paperId))
               .all();

          return NextResponse.json({ relatedPapers: results });
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

          const refs = parseReferences(ocrResult);
          const terms = refs.map((r) => r.searchTerm);
          const isDoiFlags = refs.map((r) => r.isDoi);

          if (!terms.length) {
               return NextResponse.json(
                    { error: "No references found in paper OCR. Cannot build related-papers graph." },
                    { status: 422 }
               );
          }

          // 3. Build the graph
          const method = configManager.getConfig(
               "personalization.graphConstructionMethod",
               GraphConstructionMethod.Snowball
          );

          const response = await buildRelatedPapersGraph(
               method,
               terms,
               isDoiFlags,
               pdfTitle,
               pdfDoi
          );

          // 4. Save to database (refreshing existing ones)
          db.transaction((tx) => {
               tx.delete(relatedPapers).where(eq(relatedPapers.paperId, paperIdValue)).run();

               for (const rp of response.rankedPapers) {
                    tx.insert(relatedPapers).values({
                         paperId: paperIdValue,
                         title: rp.title,
                         authors: rp.authors || null,
                         year: rp.year || null,
                         venue: rp.venue || null,
                         abstract: rp.snippet || null,
                         doi: rp.domain === "doi.org" ? rp.paperId : null,
                         semanticScholarId: rp.paperId,
                         relevanceScore: rp.score,
                         bcScore: rp.bcScore,
                         ccScore: rp.ccScore,
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
