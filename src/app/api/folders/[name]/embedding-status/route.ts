import { NextRequest, NextResponse } from "next/server";

import { getEmbeddingProgress } from "@/lib/embed/progress";

export async function GET(_req: NextRequest, { params }: { params: { name: string } }) {
     const folderName = decodeURIComponent(params?.name ?? "").trim();

     if (!folderName) {
          return NextResponse.json({ error: "Folder name is required." }, { status: 400 });
     }

     const progress = getEmbeddingProgress(folderName);
     return NextResponse.json({ progress });
}
