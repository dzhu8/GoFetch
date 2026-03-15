import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { libraryFolders, papers } from "@/server/db/schema";
import { eq, like, or } from "drizzle-orm";
import fs from "fs";

/**
 * GET /api/cli/library/ocr?paperId=<id>
 *   → Returns OCR JSON for the paper with the given numeric id.
 *
 * GET /api/cli/library/ocr?term=<text>&matchType=lexical[&folderName=<name>]
 *   → Lexical search against fileName and title columns (SQL LIKE).
 *     When ≤1 match: returns the OCR JSON directly.
 *     When 2–3 matches: returns a `matches` array so the caller can present
 *     a selection to the user, then re-call with the chosen `paperId`.
 *
 * GET /api/cli/library/ocr?term=<doi>&matchType=doi[&folderName=<name>]
 *   → Exact DOI match.
 */
export async function GET(req: NextRequest) {
     const paperIdParam = req.nextUrl.searchParams.get("paperId");
     const term = req.nextUrl.searchParams.get("term");
     const matchType = req.nextUrl.searchParams.get("matchType") ?? "lexical"; // "lexical" | "doi"
     const folderName = req.nextUrl.searchParams.get("folderName");

     if (!paperIdParam && !term) {
          return NextResponse.json(
               { error: "Either 'paperId' or 'term' is required" },
               { status: 400 },
          );
     }

     // ── Resolve by direct paperId ─────────────────────────────────────────
     if (paperIdParam) {
          const paperId = parseInt(paperIdParam, 10);
          if (isNaN(paperId)) {
               return NextResponse.json({ error: "Invalid paperId" }, { status: 400 });
          }
          const paper = db.select().from(papers).where(eq(papers.id, paperId)).get();
          if (!paper) {
               return NextResponse.json({ error: "Paper not found" }, { status: 404 });
          }
          return ocrResponse(paper);
     }

     // ── Search by term ────────────────────────────────────────────────────
     const matchCondition =
          matchType === "doi"
               ? eq(papers.doi, term!)
               : or(like(papers.fileName, `%${term!}%`), like(papers.title, `%${term!}%`));

     let candidates = db.select().from(papers).where(matchCondition).limit(10).all();

     // Optionally narrow to a specific folder
     if (folderName) {
          const folder = db
               .select({ id: libraryFolders.id })
               .from(libraryFolders)
               .where(eq(libraryFolders.name, folderName))
               .get();
          if (folder) {
               candidates = candidates.filter((p) => p.folderId === folder.id);
          }
     }

     if (candidates.length === 0) {
          return NextResponse.json(
               { matches: [], message: "No papers found matching the given term." },
               { status: 404 },
          );
     }

     const top3 = candidates.slice(0, 3);

     // Multiple matches: return choices so the caller can prompt the user,
     // then re-call with the chosen paperId to receive the full OCR JSON.
     if (top3.length > 1) {
          return NextResponse.json({
               requiresSelection: true,
               matches: top3.map((p, i) => ({
                    index: i,
                    paperId: p.id,
                    fileName: p.fileName,
                    title: p.title ?? null,
                    doi: p.doi ?? null,
                    status: p.status,
               })),
          });
     }

     // Exactly one match: return OCR directly
     return ocrResponse(top3[0]);
}

// ── Helper ────────────────────────────────────────────────────────────────────

type Paper = typeof papers.$inferSelect;

function ocrResponse(paper: Paper): NextResponse {
     const ocrPath = paper.filePath.replace(/\.pdf$/i, "") + ".ocr.json";

     if (!fs.existsSync(ocrPath)) {
          return NextResponse.json(
               {
                    paper: paperMeta(paper),
                    ocrPath,
                    error: "OCR file not found on disk",
               },
               { status: 404 },
          );
     }

     let ocrJson: unknown;
     try {
          ocrJson = JSON.parse(fs.readFileSync(ocrPath, "utf-8"));
     } catch {
          return NextResponse.json(
               { paper: paperMeta(paper), ocrPath, error: "Failed to parse OCR JSON" },
               { status: 500 },
          );
     }

     return NextResponse.json({
          paper: paperMeta(paper),
          ocrPath,
          ocrJson,
     });
}

function paperMeta(paper: Paper) {
     return {
          id: paper.id,
          fileName: paper.fileName,
          title: paper.title ?? null,
          doi: paper.doi ?? null,
          status: paper.status,
     };
}
