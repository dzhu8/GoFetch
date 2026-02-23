import { NextRequest, NextResponse } from "next/server";
import db from "@/server/db";
import { papers } from "@/server/db/schema";
import { eq } from "drizzle-orm";

// GET /api/papers?folderId=123 — list papers in a folder
export async function GET(req: NextRequest) {
     try {
          const folderId = req.nextUrl.searchParams.get("folderId");
          if (!folderId) {
               return NextResponse.json({ error: "folderId is required" }, { status: 400 });
          }

          const rows = db
               .select()
               .from(papers)
               .where(eq(papers.folderId, parseInt(folderId, 10)))
               .orderBy(papers.createdAt)
               .all();

          return NextResponse.json({ papers: rows });
     } catch (error) {
          console.error("Error fetching papers:", error);
          return NextResponse.json({ error: "Failed to fetch papers" }, { status: 500 });
     }
}
